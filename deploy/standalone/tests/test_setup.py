import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

spec = importlib.util.spec_from_file_location("worker_setup", Path(__file__).resolve().parents[1] / "setup.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupSafetyTests(unittest.TestCase):
    @unittest.skipUnless(os.geteuid() == 0, "Automatic TLS installation requires root")
    def test_automatic_certificates_preserve_trust_when_ip_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            cert, key, ca, changed = setup.automatic_tls("127.0.0.1", target)
            self.assertTrue(changed)
            trust = ca.read_bytes()
            original = cert.read_bytes()
            setup.validate_certificate("127.0.0.1", cert, key)
            self.assertEqual((target / "tls/authority/ca.key").stat().st_mode & 0o777, 0o600)
            self.assertEqual((target / "tls/authority").stat().st_mode & 0o777, 0o700)
            _, _, _, changed = setup.automatic_tls("127.0.0.1", target)
            self.assertFalse(changed)
            self.assertEqual(original, cert.read_bytes())
            cert, key, ca, changed = setup.automatic_tls("192.0.2.1", target)
            self.assertTrue(changed)
            self.assertEqual(trust, ca.read_bytes())
            setup.validate_certificate("192.0.2.1", cert, key)
            setup.run(["openssl", "verify", "-CAfile", str(ca), str(cert)])

    def test_addresses_cannot_inject_compose_or_shell(self):
        for value in ("https://host", "host:8090", "host\nOTHER=value", "$(touch file)", "bad..host", "-bad.test"):
            with self.assertRaises(ValueError):
                setup.validate_host(value)
        self.assertEqual(setup.validate_host("194.5.79.198"), "194.5.79.198")
        self.assertEqual(setup.validate_host("Worker.Example.org"), "worker.example.org")

    @unittest.skipUnless(os.geteuid() == 0, "Ownership test requires root in disposable Linux container")
    def test_replacing_configuration_retains_owner_and_private_mode(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / ".env"
            path.write_text("old=value\n")
            os.chown(path, 1001, 1001)
            setup.write_file(path, "new=value\n")
            self.assertEqual(path.stat().st_uid, 1001)
            self.assertEqual(path.stat().st_gid, 1001)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_symlink_configuration_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / "original"
            original.write_text("unchanged")
            link = root / ".env"
            link.symlink_to(original)
            with self.assertRaises(ValueError):
                setup.write_file(link, "new=value")
            self.assertEqual(original.read_text(), "unchanged")

    def test_certificate_name_and_key_are_checked_before_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cert, key = root / "cert.pem", root / "key.pem"
            setup.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                       "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
                       "-keyout", str(key), "-out", str(cert)])
            setup.validate_certificate("127.0.0.1", cert, key)
            setup.validate_certificate("localhost", cert, key)
            with self.assertRaises((ValueError, RuntimeError)):
                setup.validate_certificate("192.0.2.1", cert, key)
            wrong_key = root / "other.pem"
            setup.run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(wrong_key)])
            with self.assertRaises(ValueError):
                setup.validate_certificate("localhost", cert, wrong_key)
