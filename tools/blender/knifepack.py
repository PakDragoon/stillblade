"""
Package V part 1: the owner's "Knife FPS Animations" pack (Fab Standard License, free;
tools/blender/source-art/realistic/fp-anims/knife_fps_animations.unitypackage, git-ignored).

A .unitypackage is a gzipped tar of Unity GUID folders, each holding `pathname` (a text file: the asset's path in the
Unity project) and `asset` (the file itself). It is read here as data with the standard library's tarfile: only the
files listed in WANTED are written, each to a path built from its own `pathname` after checking it stays inside the
output folder. Nothing in the package (its C# scripts, prefabs, scenes) is run or imported.

    python -I tools/blender/knifepack.py            extracts into build/unzipped/knife-pack/ and lists what it wrote

Used by fpknife.py (the first-person knife rig), weapons.py (the third-person karambit and the knife atlas) and
tools/process-audio-knife.mjs (the swing recordings).
"""
import os
import posixpath
import re
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'source-art', 'realistic', 'fp-anims', 'knife_fps_animations.unitypackage')
OUT = os.path.join(HERE, 'source-art', 'realistic', 'build', 'unzipped', 'knife-pack')
ART = 'Assets/Knife_FPS_Animations/Art/'
# What is used (paths under ART): the first-person hands and their clips, the knife and its clips, the 2k textures
# (not the 4k ones). The pack's demo audio is excluded.
WANTED = [
    r'Character/Mesh/Hands_rig\.fbx',
    r'Character/Animations/AS_Hands_[a-z_0-9]+\.fbx',
    r'Character/Textures/2k/T_Hands_[A-Za-z]+\.png',
    r'Weapon/Mesh/SKM_Knife\.fbx',
    r'Weapon/Animations/AS_Knife_[a-z_]+\.fbx',
    r'Weapon/Textures/2k/T_ViperFANG_2k_[A-Za-z]+\.png',
]
_WANTED = [re.compile(re.escape(ART) + w + '$') for w in WANTED]


def available():
    return os.path.exists(SRC) or os.path.isdir(OUT)


def extract(src=SRC, out=OUT):
    """Writes the wanted files to `out`/<path under ART> (once; a later call reuses them). Returns `out`."""
    stamp = os.path.join(out, '.extracted')
    if os.path.exists(stamp):
        return out
    if not os.path.exists(src):
        raise FileNotFoundError(f'{src} is missing: copy the owner\'s knife pack there (see HANDOFF "Package V")')
    os.makedirs(out, exist_ok=True)
    root = os.path.realpath(out)
    with tarfile.open(src, 'r:gz') as tar:
        members = {m.name.lstrip('./'): m for m in tar.getmembers() if m.isfile()}
        written = 0
        for name, m in sorted(members.items()):
            if not name.endswith('/pathname'):
                continue
            guid = name[:-len('/pathname')]
            path = tar.extractfile(m).read().decode('utf8', 'replace').splitlines()[0].strip()
            if not any(w.match(path) for w in _WANTED):
                continue
            asset = members.get(guid + '/asset')
            if asset is None:
                continue
            rel = posixpath.normpath(path[len(ART):])
            dst = os.path.realpath(os.path.join(root, *rel.split('/')))
            if not dst.startswith(root + os.sep) or rel.startswith('..'):
                raise ValueError(f'unsafe path in the package: {path!r}')
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, 'wb') as f:
                f.write(tar.extractfile(asset).read())
            written += 1
    with open(stamp, 'w') as f:
        f.write(f'{written}\n')
    return out


def path(rel):
    """A file of the pack (path under ART), extracting first if needed."""
    return os.path.join(extract(), *rel.split('/'))


if __name__ == '__main__':
    o = extract()
    for d, _, files in os.walk(o):
        for f in sorted(files):
            p = os.path.join(d, f)
            print(os.path.relpath(p, o).replace('\\', '/'), os.path.getsize(p))
    sys.exit(0)
