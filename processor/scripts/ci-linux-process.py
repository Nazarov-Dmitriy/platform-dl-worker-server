import json, pathlib, subprocess, tempfile, sys

scripts = json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='worker-ci-test-') as folder:
    root = pathlib.Path(folder)
    (root / 'run.sh').write_text("#!/bin/bash\ntrap 'exit 0' TERM\necho 'Listening for Jobs'\nwhile true; do sleep 0.1; done\n")
    (root / 'run.sh').chmod(0o700)
    running = subprocess.Popen(['bash', '-c', scripts['RUN'], 'worker-ci', folder], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert running.stdout.readline().strip() == 'Listening for Jobs'
        pid = int((root / '.worker-ci.pid').read_text())
        assert pid > 1
        duplicate = subprocess.run(['bash', '-c', scripts['RUN'], 'worker-ci', folder], capture_output=True, timeout=5)
        assert duplicate.returncode == 73, duplicate.stderr
        stopped = subprocess.run(['bash', '-c', scripts['STOP'], 'worker-ci', folder], capture_output=True, timeout=5)
        assert stopped.returncode == 0, stopped.stderr
        running.communicate(timeout=5)
        assert running.returncode == 0, running.returncode
        assert not (root / '.worker-ci.pid').exists()
        # A PID pointing outside this directory must never be signalled.
        foreign = subprocess.Popen(['sleep', '30'])
        try:
            (root / '.worker-ci.pid').write_text(str(foreign.pid))
            wrong = subprocess.run(['bash', '-c', scripts['STOP'], 'worker-ci', folder], capture_output=True, timeout=5)
            assert wrong.returncode == 63, wrong.returncode
            assert foreign.poll() is None
        finally:
            foreign.terminate(); foreign.wait(timeout=5)
        print('Linux process lifecycle: start, duplicate lock, owned stop, cleanup and foreign PID guard PASS')
    finally:
        if running.poll() is None:
            subprocess.run(['bash', '-c', scripts['STOP'], 'worker-ci', folder], capture_output=True, timeout=5)
            running.communicate(timeout=5)
