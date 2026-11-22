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
