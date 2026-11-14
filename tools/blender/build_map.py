"""
Builds one Stillblade map from its definition in tools/blender/maps/<id>.py.

    npm run map -- <id>                      (verify, process textures, bake, export)
    npm run map -- <id> --no-bake            (reuse the existing <id>_baked.webp; the lightmap UV
                                              layout is deterministic, so it still lines up)
    npm run map -- <id> --samples 64 --size 1024     (quick look-dev overrides)
    npm run map -- <id> --verify-only        (checks only; also: python tools/blender/mapkit.py <id>)

which runs: blender --background --python tools/blender/build_map.py -- <id> [options]
The build fails (non-zero exit) when any verification check fails.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {"bake": True, "samples": None, "size": None, "verify_only": False, "map": None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--no-bake":
            opts["bake"] = False
        elif a == "--verify-only":
            opts["verify_only"] = True
        elif a in ("--samples", "--size") and i + 1 < len(argv):
            opts[a[2:]] = int(argv[i + 1])
            i += 1
        elif not a.startswith("-") and opts["map"] is None:
            opts["map"] = a
        else:
            raise SystemExit("[map] unknown argument: %s" % a)
        i += 1
    if not opts["map"]:
        raise SystemExit("[map] usage: build_map.py -- <map id> [--no-bake] [--samples N] [--size N]")
    return opts


def main():
    import mapkit
    opts = parse_args()
    m = mapkit.load_map(opts["map"])
    mapkit.verify(m, log=lambda s: print("[map] " + s, flush=True))
    if opts["verify_only"]:
        return
    import mapbuilder
    mapbuilder.build(m, opts)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # make headless runs fail loudly with non-zero exit
        import traceback
        traceback.print_exc()
        print("[map] ERROR: %s" % exc, flush=True)
        sys.exit(1)
