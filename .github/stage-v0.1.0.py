import hashlib
import json
import shutil
import zipfile
from pathlib import Path

stage = Path.cwd()
original = stage / 'original'
linux = stage / 'linux'

sources = {
    original / 'desktop-windows-x64': {
        'our-pets-desktop-0.1.0-windows-x64.exe', 'our-pets-notices-0.1.0-windows-x64.zip',
    },
    original / 'desktop-macos-universal': {
        'our-pets-desktop-0.1.0-macos-universal.dmg', 'our-pets-notices-0.1.0-macos-universal.zip',
    },
    original / 'server-packages': {
        f'our-pets-server-0.1.0-{target}.zip'
        for target in ('linux-amd64', 'linux-arm64', 'windows-amd64', 'darwin-amd64', 'darwin-arm64')
    },
    linux: {
        'our-pets-desktop-0.1.0-linux-x64.deb', 'our-pets-desktop-0.1.0-linux-x64.AppImage',
        'our-pets-notices-0.1.0-linux-x64.zip', 'our-pets-linux-native-sources-0.1.0.zip',
    },
}
for directory, expected in sources.items():
    files = {file.name for file in directory.iterdir() if file.is_file() and file.stat().st_size}
    if files != expected:
        raise SystemExit(f'Unexpected artifacts in {directory}: {sorted(files)}')

with (linux / 'our-pets-desktop-0.1.0-linux-x64.AppImage').open('rb') as image:
    checksum = hashlib.sha256()
    for chunk in iter(lambda: image.read(1024 * 1024), b''):
        checksum.update(chunk)
    digest = checksum.hexdigest()
with zipfile.ZipFile(linux / 'our-pets-linux-native-sources-0.1.0.zip') as archive:
    manifest = json.loads(archive.read('native-components.json'))
    if manifest['appimageSha256'] != digest or not manifest['components'] or not manifest['sourcePackages']:
        raise SystemExit('Native source manifest does not match the Linux AppImage')
    for prefix in ('sources/', 'copyrights/', 'common-licenses/'):
        if not any(name.startswith(prefix) for name in archive.namelist()):
            raise SystemExit(f'Missing Linux archive entries under {prefix}')

for directory, filenames in sources.items():
    for filename in sorted(filenames):
        shutil.copyfile(directory / filename, stage / 'release-out' / filename)
print(f'Staged {sum(len(files) for files in sources.values())} verified release artifacts.')
