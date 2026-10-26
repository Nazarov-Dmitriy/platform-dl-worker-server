#!/usr/bin/env python3
"""Actual Docker failure/rollback on disposable data and localhost-only port."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import uuid


def run(args, data=None):
    result = subprocess.run(args, input=data, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors='replace'))
    return result.stdout


def smoke(bundle):
    project = 'worker-rollback-smoke-' + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory(prefix='worker-rollback-') as temp:
        root = Path(temp)
        package = root / 'package'
        package.mkdir()
        with tarfile.open(bundle) as archive: archive.extractall(package, filter='data')
        sys.path.insert(0, str(package))
        import update
        from fingerprint import image_fingerprint
        from manage import read_env, ready
        target = package / 'instance'
        environment = dict(os.environ, WORKER_PROJECT_NAME=project, WORKER_UPDATER_SERVICE='0')
        compose = ['docker','compose','--project-name',project,'--project-directory',str(target),'--env-file',str(target/'.env'),'-f',str(target/'compose.yaml')]
        original_run = update.Updater.run
        try:
            result = subprocess.run(['bash',str(package/'worker'),'install','--host','127.0.0.1','--port','18093','--listen-ip','127.0.0.1','--password-stdin'],input=b'rollback-test-password\n',capture_output=True,env=environment)
            if result.returncode: raise RuntimeError(result.stderr.decode(errors='replace'))
            original_env = (target/'.env').read_bytes()
            original_ca = (target/'data/device-ca.crt').read_bytes()
            original_version = (package/'VERSION').read_bytes()
            current = read_env(target/'.env')['DISPATCHER_IMAGE']
            candidate = 'worker-dispatcher:worker-v99.0.0'
            context = root/'bad'; context.mkdir()
            (context/'Dockerfile').write_text('FROM '+current+'\nENTRYPOINT ["/bin/sh","-c","exit 31"]\n')
            run(['docker','build','-t',candidate,str(context)])
            stage = root/'release'; stage.mkdir()
            with tarfile.open(bundle) as archive: archive.extractall(stage, filter='data')
            run(['docker','save','-o',str(root/'bad-image.tar'),candidate])
            with (root/'bad-image.tar').open('rb') as source,gzip.open(stage/'dispatcher-image.tar.gz','wb') as out:
                import shutil;shutil.copyfileobj(source,out)
            (stage/'release.env').write_text('DISPATCHER_IMAGE='+candidate+'\nDISPATCHER_IMAGE_FINGERPRINT='+image_fingerprint(candidate)+'\n')
            (stage/'VERSION').write_text('worker-v99.0.0\n')
            archive_path = root/'candidate.tgz'
            with tarfile.open(archive_path,'w:gz') as archive:
                for name in update.FILES:archive.add(stage/name,arcname=name)
            with archive_path.open('rb') as source:digest=hashlib.file_digest(source,'sha256').hexdigest()
            class FixtureRelease:
                def release(self, tag=None):return {'tag_name':'worker-v99.0.0'}
                def asset(self, release, name, destination=None):
                    if destination:
                        import shutil;shutil.copyfile(archive_path,destination)
                    else:return dict(protocol=1,version='worker-v99.0.0',asset='worker-server-linux-amd64-worker-v99.0.0.tgz',sha256=digest)
            updater=update.Updater(package,target,project,FixtureRelease())
            def health():
                updater.compose('up','-d','--wait','--wait-timeout','8')
                ready(target,'127.0.0.1',18093,'127.0.0.1')
            updater.health=health
            try:updater.install('worker-v99.0.0')
            except RuntimeError:pass
            else:raise AssertionError('Broken image unexpectedly accepted')
            assert updater.status()['phase']=='rolled_back',updater.status()
            assert (target/'.env').read_bytes()==original_env
            assert (target/'data/device-ca.crt').read_bytes()==original_ca
            assert (package/'VERSION').read_bytes()==original_version
            ready(target,'127.0.0.1',18093,'127.0.0.1')
            assert not updater.journal.exists()
            print('PASS: real failing Docker image, previous container healthy, full data/CA/version restored')
        finally:
            if (target/'.env').exists():run(compose+['down'])


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('bundle');smoke(parser.parse_args().bundle)
