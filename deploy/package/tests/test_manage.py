import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import manage

class PackageTests(unittest.TestCase):
    def test_address_does_not_accept_shell_or_environment_syntax(self):
        self.assertTrue(manage.valid_host("194.5.79.198"))
        self.assertTrue(manage.valid_host("worker.example.org"))
        for host in ("", "https://site", "site:8090", "site\nSECRET=value", "$(command)", "site..org"):
            self.assertFalse(manage.valid_host(host))

    @unittest.skipUnless(os.geteuid() == 0, "Requires disposable Linux root")
    def test_existing_env_owner_is_preserved(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/".env"
            path.write_text("previous=value")
            os.chown(path,1001,1001)
            manage.write(path,"current=value")
            self.assertEqual(path.stat().st_uid,1001)
            self.assertEqual(path.stat().st_gid,1001)
            self.assertEqual(path.stat().st_mode & 0o777,0o600)

    def test_symlink_is_not_followed(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root)
            original=root/"original"
            original.write_text("keep")
            link=root/".env"
            link.symlink_to(original)
            with self.assertRaises(ValueError):manage.write(link,"replace")
            self.assertEqual(original.read_text(),"keep")
