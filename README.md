## Knotro

### why

In this branch of the fork, you will find a modified version of the original app but with the deta python library replaced by a local solution. Below the new sections is a copy of the original readme.

### how

To use this navigate into the `app` directory and create a new folder called `data`. In there put the `knotro_notes.json` file and the `notes` folder from your deta space export. Then after installing the requirements, you can run the app with `uvicorn main:app` from the `app` directory.

---

### General Info

*Knotro* gives you a "box" of notes. It is a minimal micro-homage to the bi-directional linking in tools like Roam Research, Obsidian, etc.


### Deployment / Usage

Knotro is running on [Deta Space](https://deta.space/discovery/@max/knospace).

It could, with little modification, be configured to run elsewhere (it's a FastAPI app), but a database is needed.

### Other Info

The `app` directory contains the app

### Libraries Used

- [FastAPI](https://fastapi.tiangolo.com/)
- [Jinja2](https://jinja.palletsprojects.com/en/2.11.x/)
- [Bleach](https://bleach.readthedocs.io/en/latest/clean.html)
- [Deta](https://www.deta.sh/)
- [hyperapp](https://github.com/jorgebucaran/hyperapp)
- [Showdown](http://showdownjs.com/)
- [CodeJar](https://github.com/antonmedv/codejar)
- [highlightjs](https://highlightjs.org/usage/)
