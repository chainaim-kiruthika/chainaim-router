"""Copy Presidio's recognizer registry config, enabling the named predefined recognizers.

Usage: enable_recognizers.py SOURCE.yaml DEST.yaml RecognizerName [RecognizerName ...]
Exits non-zero (failing the image build) if a named recognizer is not in SOURCE.
"""
import sys

import yaml


def main() -> None:
    source, dest, *names = sys.argv[1:]
    with open(source, encoding="utf-8") as f:
        conf = yaml.safe_load(f)
    found = set()
    for recognizer in conf.get("recognizers", []):
        if isinstance(recognizer, dict) and recognizer.get("name") in names:
            recognizer["enabled"] = True
            found.add(recognizer["name"])
    missing = sorted(set(names) - found)
    if missing:
        sys.exit(f"recognizers not found in {source}: {', '.join(missing)}")
    with open(dest, "w", encoding="utf-8") as f:
        yaml.safe_dump(conf, f, sort_keys=False)
    print(f"enabled {', '.join(sorted(found))} in {dest}")


if __name__ == "__main__":
    main()
