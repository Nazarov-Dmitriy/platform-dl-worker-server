import hashlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import update


class FakeGitHub:
    tag = 'worker-v0.1.0'

    def __init__(self, bundle):
        self.bundle = bundle
        self.manifest = dict(protocol=1, version=self.tag, asset='worker-server-linux-amd64-'+self.tag+'.tgz', sha256=hashlib.sha256(bundle).hexdigest())

    def release(self, tag=None):
        if tag and tag != self.tag:
            raise ValueError('Unknown tag')
        return {'tag_name': self.tag}

    def asset(self, release, name, destination=None):
        if destination:
            Path(destination).write_bytes(self.bundle)
        else:
            return self.manifest


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / 'instance'
        (self.target / 'data').mkdir(parents=True)
        self.original = 'DISPATCHER_IMAGE=old-image\nDISPATCHER_HOST=127.0.0.1\nPUBLIC_PORT=18099\n'
        (self.target / '.env').write_text(self.original)
        (self.target / 'data/device-ca.crt').write_bytes(b'original certificate')
        with sqlite3.connect(self.target / 'data/dispatcher.db') as db:
            db.executescript("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO metadata VALUES('maintenance','0'); CREATE TABLE assignments(state TEXT); CREATE TABLE accounts(login TEXT); INSERT INTO accounts VALUES('owner');")
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz') as archive:
            for name in update.FILES:
                data = b'fixture'
                if name == 'VERSION': data = b'worker-v0.1.0\n'
                if name == 'release.env': data = b'DISPATCHER_IMAGE=worker-dispatcher:worker-v0.1.0\nDISPATCHER_IMAGE_FINGERPRINT=fingerprint\n'
                info = tarfile.TarInfo('./'+name); info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        self.github = FakeGitHub(stream.getvalue())
        self.updater = update.Updater(self.root, self.target, 'test-only', self.github)
        self.updater.run = lambda *a, **kw: b''
        self.updater.compose = lambda *args: None
        self.updater.health = lambda: None

    def test_version_comparison_and_invalid_releases(self):
        self.assertGreater(update.version('worker-v1.10.0'), update.version('worker-v1.9.9'))
        for tag in ('latest','worker-v01.2.3','worker-v1.2','worker-v1.2.3;rm','worker-v1.2.3-beta'):
            with self.assertRaises(ValueError): update.version(tag)

    def test_checksum_rejected_before_maintenance_or_stop(self):
        self.github.manifest['sha256'] = '0'*64
        with self.assertRaises(ValueError), patch('update.image_fingerprint',return_value='fingerprint'):
            self.updater.install(self.github.tag)
        self.assertEqual((self.target / '.env').read_text(), self.original)
        self.assertFalse(self.updater.draining)

    def test_archive_traversal_and_links_rejected(self):
        for name, kind in [('../escape',tarfile.REGTYPE),('worker',tarfile.SYMTYPE)]:
            path=self.root/'malicious.tgz'
            with tarfile.open(path,'w:gz') as archive:
                info=tarfile.TarInfo(name); info.type=kind;info.linkname='/etc/passwd'
                archive.addfile(info)
            with self.assertRaises(ValueError): update.unpack(path,self.root)

    def test_success_preserves_ca_accounts_and_resumes(self):
        with patch('update.image_fingerprint',return_value='fingerprint'):
            self.updater.install(self.github.tag)
        self.assertEqual(self.updater.status()['phase'],'completed')
        self.assertEqual((self.target/'data/device-ca.crt').read_bytes(),b'original certificate')
        with sqlite3.connect(self.target/'data/dispatcher.db') as db:
            self.assertEqual(db.execute('SELECT login FROM accounts').fetchone()[0],'owner')
            self.assertEqual(db.execute("SELECT value FROM metadata WHERE key='maintenance'").fetchone()[0],'0')
        self.assertFalse(self.updater.journal.exists())

    def test_failed_image_restores_full_database_ca_and_version(self):
        calls=[]
        def health():
            calls.append(True)
            if len(calls)==1:
                (self.target/'data/device-ca.crt').write_bytes(b'changed by failed version')
                with sqlite3.connect(self.target/'data/dispatcher.db') as db:db.execute('DELETE FROM accounts')
                raise RuntimeError('unhealthy')
        self.updater.health=health
        with self.assertRaises(RuntimeError),patch('update.image_fingerprint',return_value='fingerprint'):
            self.updater.install(self.github.tag)
        self.assertEqual(self.updater.status()['phase'],'rolled_back')
        self.assertEqual((self.target/'.env').read_text(),self.original)
        self.assertEqual((self.target/'data/device-ca.crt').read_bytes(),b'original certificate')
        self.assertEqual(self.updater.current(),'worker-v0.0.0')
        with sqlite3.connect(self.target/'data/dispatcher.db') as db:
            self.assertEqual(db.execute('SELECT login FROM accounts').fetchone()[0],'owner')

    def test_waits_for_active_assignment_and_keeps_existing_maintenance(self):
        self.updater.maintenance(True)
        with sqlite3.connect(self.target/'data/dispatcher.db') as db:db.execute("INSERT INTO assignments VALUES('RUNNING')")
        def finish(_):
            with sqlite3.connect(self.target/'data/dispatcher.db') as db:db.execute('DELETE FROM assignments')
        with patch('update.image_fingerprint',return_value='fingerprint'),patch('update.time.sleep',side_effect=finish) as sleep:
            self.updater.install(self.github.tag)
            sleep.assert_called_once()
        self.assertFalse(self.updater.resume)
        with sqlite3.connect(self.target/'data/dispatcher.db') as db:
            self.assertEqual(db.execute("SELECT value FROM metadata WHERE key='maintenance'").fetchone()[0],'1')

    def test_concurrent_operation_and_downgrade_rejected(self):
        self.updater.lock.acquire()
        with self.assertRaises(ValueError): self.updater.command('check')
        self.updater.lock.release()
        with self.assertRaises(ValueError): self.updater.command('install','worker-v0.0.0')

    def test_manifest_must_match_release(self):
        with self.assertRaises(ValueError): update.validate_manifest(self.github.manifest,'worker-v0.2.0')


if __name__=='__main__':unittest.main()
