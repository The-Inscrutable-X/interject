#!/bin/sh
# Put the demo videos and pictures from this computer on the "media" branch.
#
# They live on their own branch, not on main, because installing the mod
# downloads the main branch. The videos and pictures are about 80 MB, and the
# mod's code is under 1 MB, so keeping them off main keeps installs small.
#
# This makes one new commit on "media" that holds exactly the .mp4, .png and
# .jpg files in demo/, demo/stills/ and demo/thread/, plus a short README.
# It does not change the branch that you have checked out, or your files.
#
# Usage, from anywhere in the repo:
#   sh demo/video/publish_media.sh ["commit message"]
#   git push origin media
set -eu
cd "$(git rev-parse --show-toplevel)"
msg="${1:-Update the demo videos and pictures}"

# Build the commit in a scratch index, so the real index is left alone.
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
GIT_INDEX_FILE="$scratch/index"
export GIT_INDEX_FILE

readme=$(git hash-object -w --stdin <<'EOF'
# Interject demo media

This branch holds the demo videos and pictures for
[Interject](https://github.com/The-Inscrutable-X/interject), a Claude Code mod.

They are kept off the main branch on purpose. Installing the mod downloads
the main branch, and these files are about 80 MB, while the mod's code is
under 1 MB.

- `demo/interject-desktop-demo.mp4`: the 3-minute narrated demo in Claude
  Code Desktop (1080p), with two smaller copies: `-web` (1600 wide) and
  `-720p` (under 10 MB)
- `demo/stills/`: one picture per feature
- `demo/thread/`: the pictures and the teaser video for the launch thread on X
- `demo/interject-demo.mp4`: an older demo in the terminal

The scripts that make these files, and the thread's text, are on the main
branch in `demo/`. Running `sh demo/video/publish_media.sh` there updates
this branch.
EOF
)
git update-index --add --cacheinfo "100644,$readme,README.md"

find demo -maxdepth 2 -type f \( -name '*.mp4' -o -name '*.png' -o -name '*.jpg' \) \
  ! -path 'demo/raw/*' ! -path 'demo/video/*' | sort | while read -r f; do
  git update-index --add --cacheinfo "100644,$(git hash-object -w "$f"),$f"
done
tree=$(git write-tree)

if parent=$(git rev-parse -q --verify refs/heads/media); then
  if [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
    echo "media is already up to date"; exit 0
  fi
  commit=$(git commit-tree "$tree" -p "$parent" -m "$msg")
else
  commit=$(git commit-tree "$tree" -m "$msg")
fi
git update-ref refs/heads/media "$commit"
echo "media is now $(git rev-parse --short "$commit"). Push it with: git push origin media"
