import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import manage

class PublicCertificateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.target = Path(self.temp.name)
        (self.target / "data/tls").mkdir(parents=True)
        (self.target / ".env").write_text("DISPATCHER_HOST=194.5.79.198\n")
        self.manager = manage.PublicCertificate(self.target, "test-worker")

    def test_private_ip_domain_and_command_injection_are_rejected(self):
        for value in ("127.0.0.1", "10.0.0.1", "example.com", "194.5.79.198;touch /tmp/x"):
            (self.target / ".env").write_text("DISPATCHER_HOST=" + value)
            with self.assertRaises(ValueError): self.manager.host()

    def test_failure_preserves_active_certificate_and_renewal(self):
        active = self.target / "data/tls/public.json"
        active.write_text("previous")
        self.manager.publish(enabled=True, host="194.5.79.198")
        with patch.object(self.manager, "challenge", side_effect=RuntimeError("offline")):
            with self.assertRaises(RuntimeError): self.manager.run()
        self.assertEqual(active.read_text(), "previous")
        self.assertTrue(self.manager.state()["enabled"])
        self.assertFalse(self.manager.state()["busy"])

    def test_issue_uses_fixed_image_and_profile_without_force_renewal(self):
        live = self.target / "acme/live/worker-ip"
        live.mkdir(parents=True)
        for name in ("fullchain.pem", "privkey.pem", "cert.pem", "chain.pem"): (live/name).write_text("fixture")
        with patch.object(self.manager, "challenge", return_value=([self.manager.IMAGE],["--standalone"])), \
             patch("manage.subprocess.run") as execute, patch("manage.run"), \
             patch("manage.ssl._ssl._test_decode_cert", return_value={"notAfter": "Oct 31 12:00:00 2030 GMT"}), \
             patch.object(self.manager,"install_bundle") as install:
            execute.return_value.returncode = 0
            self.manager.run(enable=True)
            command = execute.call_args.args[0]
            self.assertIn("certbot/certbot:v5.4.0",command)
            self.assertIn("shortlived",command)
            self.assertIn("--ip-address",command)
            self.assertIn("--keep-until-expiring",command)
            self.assertNotIn("--force-renewal",command)
            install.assert_called_once()
        self.assertTrue(self.manager.state()["enabled"])
        self.assertGreater(self.manager.state()["expiresAt"], time.time())

    def test_staging_never_installs_untrusted_certificate(self):
        with patch.object(self.manager, "challenge", return_value=([self.manager.IMAGE],["--standalone"])), \
             patch("manage.subprocess.run") as execute, patch.object(self.manager,"install_bundle") as install:
            execute.return_value.returncode = 0
            self.manager.run(enable=True,staging=True)
            self.assertIn("--staging",execute.call_args.args[0])
            install.assert_not_called()
        self.assertFalse(self.manager.state()["enabled"])

    def test_application_directory_symlink_is_not_followed(self):
        (self.target / "data/tls").rmdir()
        elsewhere=self.target / "elsewhere";elsewhere.mkdir()
        (self.target / "data/tls").symlink_to(elsewhere)
        with self.assertRaises(OSError): self.manager.install_bundle({"privateKey":"test"})
        self.assertFalse((elsewhere / "public.json").exists())

    @unittest.skipUnless(os.geteuid() == 0,"Requires Linux root")
    def test_bundle_is_private_and_atomically_published(self):
        value={"privateKey":"test-key","certificate":"test-cert","host":"194.5.79.198"}
        self.manager.install_bundle(value)
        output=self.target / "data/tls/public.json"
        self.assertEqual(json.loads(output.read_text()),value)
        self.assertEqual(output.stat().st_uid,10001)
        self.assertEqual(output.stat().st_mode & 0o777,0o600)
