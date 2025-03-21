## Knotro

Knotro reimagined as an app! Knotro gives you a "box" of notes. It is minimal and allows for bi-directional linking similar to what apps like Roam Research and Obsidian do.
> In this branch you will find a desktop app based on knotro. The app uses mainly the frontend code of the original.

| ![showcase macos dark](showcase/showcase-macos-dark.png) | ![showcase linux dark](showcase/showcase-linux-dark.png) | ![showcase windows dark](showcase/showcase-windows-dark.png) |
| --- | --- | --- |

### install

Currently there is no releases, meaning you will need to build from source.
Learn more about how to build a tauri app [here](https://tauri.app/distribute/).
The app has been tested on macos, linux and windows!
I'll create releases once I've fixed more bugs and made small tweaks.

### what

The app includes some new features:

- Dark mode
- Fuzzy search
- Import .md files
- True offline support

### how

The app has basic [markdown](https://www.markdownguide.org/cheat-sheet/) support. To create backlinks, type two brackets around the note name, like this: `[[Note Name]]`.

#### keybinds

- `cmd + j` / `ctrl + j` : Toggle focus mode
- `cmd + i` / `ctrl + i` : Switch between view and edit mode
- `cmd + o` / `ctrl + o` : Add markdown file as note

### future

I'm developing a few more useful features and quality improvements that I'm planning to release soon. Any changes and features I make will maintain the original's minimal aesthetic.
