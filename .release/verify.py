#!/usr/bin/env python3
import base64, hashlib, json, os, pathlib, subprocess, sys
root = pathlib.Path(__file__).resolve().parent.parent
os.chdir(root)
def refuse(message):
    raise SystemExit('REFUSE: ' + message)
def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()
m = json.loads(pathlib.Path('.release/manifest.json').read_text())
version = m['release']['cli']['version']
if os.environ.get('GITHUB_REPOSITORY') != 'vecteurspace/vecteur-cli':
    refuse('unexpected publishing repository')
tag = 'v' + version
if os.environ.get('GITHUB_REF') != 'refs/tags/' + tag:
    refuse('tag does not match version')
sha = os.environ.get('GITHUB_SHA', '')
if not sha or git('rev-parse', 'HEAD') != sha or git('rev-parse', 'refs/tags/' + tag + '^{commit}') != sha:
    refuse('GITHUB_SHA or tag differs from checkout')
tracked = git('ls-files', '-z').split('\0')
if sorted(x for x in tracked if x) != sorted(m['tracked']):
    refuse('tracked file allowlist changed')
if git('status', '--porcelain', '--untracked-files=all'):
    refuse('checkout has modified or untracked files')
actual_files = []
for directory, dirs, files in os.walk('.', followlinks=False):
    if directory == '.':
        dirs[:] = [name for name in dirs if name != '.git']
    for name in dirs + files:
        path = pathlib.Path(directory, name)
        if path.is_symlink():
            refuse('checkout contains a symlink: ' + str(path))
    actual_files.extend(str(pathlib.Path(directory, name)) for name in files)
if sorted(actual_files) != sorted(m['tracked']):
    refuse('checkout file allowlist changed')
for name, expected in m['files'].items():
    p = pathlib.Path(name)
    if p.is_symlink() or not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != expected['sha256'] or (p.stat().st_mode & 0o777) != expected['mode']:
        refuse('file bytes or mode changed: ' + name)
if len(sys.argv) == 2:
    actual = 'sha512-' + base64.b64encode(hashlib.sha512(pathlib.Path(sys.argv[1]).read_bytes()).digest()).decode()
    if actual != m['release']['cli']['integrity']:
        refuse('repacked tarball differs from frozen release')
elif len(sys.argv) != 1:
    refuse('unexpected arguments')
print('release export verified')
