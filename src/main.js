import { h, text, app } from "https://cdn.skypack.dev/hyperapp";
const { invoke } = window.__TAURI__.core;
const Database = window.__TAURI__.sql;

const db = await Database.load("sqlite:knotro.db");

const converter = new showdown.Converter();
converter.setOption("simpleLineBreaks", true);
let jar;

// functions from python

function urlsafe_key(note_name) {
  const base64 = btoa(note_name);
  return base64.replace(/=/g, "_");
}

const list_diff = (list_one, list_two) => {
  return list_one.filter((x) => !list_two.includes(x));
};

// helpers

const nameToKey = (name) => atob(name).replaceAll("=", "_");

const linkSub = (rawMD, links) => {
  let newMD = rawMD;
  for (const each of links) {
    let replacement;
    if (each[2] !== "~") {
      const bareName = each.substring(2, each.length - 2);
      replacement = `[${bareName}](#${encodeURI(bareName)})`;
    } else {
      // if the link is escaped with ~
      const bareName = each.substring(3, each.length - 2);
      replacement = `[[${bareName}]]`;
    }
    newMD = newMD.split(each).join(replacement);
  }
  return newMD;
};

const getUniqueLinks = (rawMD) => {
  const uniqueLinks = [...new Set(rawMD.match(/\[\[(.*?)\]]/g))];
  return uniqueLinks;
};

const getBareLinks = (rawMD) => {
  let markdown = rawMD;
  const uniqueLinks = getUniqueLinks(markdown);
  const bareLinks = uniqueLinks
    .map((each) => each.substring(2, each.length - 2))
    .filter((mappedEach) => mappedEach[0] !== "~");
  return bareLinks;
};

const getlastEdited = (lastModified) => {
  if (lastModified === "saving" || lastModified === "failed to save") {
    return lastModified;
  }
  const date = new Date(lastModified);

  let elapsed = Math.abs(new Date() - date) / 1000;

  const days = Math.floor(elapsed / 86400);
  elapsed -= days * 86400;

  // calculate hours
  const hours = Math.floor(elapsed / 3600) % 24;
  elapsed -= hours * 3600;

  // calculate minutes
  const minutes = Math.floor(elapsed / 60) % 60;
  elapsed -= minutes * 60;

  if (days < 1 || days === NaN) {
    if (hours < 1 || hours === NaN) {
      return `edited: ${minutes} minutes ago`;
    } else {
      return `edited: ${hours} hours ago`;
    }
  } else {
    return `edited: ${days} days ago`;
  }
};

// EFFECTS

// checks if localStorage has a note that didn't save to the server
// should happen when a note is opened
const checkUnsaved = (options) => {
  const { note } = options;
  const { name } = note;
  const localNote = JSON.parse(localStorage.getItem(name));
  if (
    localNote &&
    new Date(localNote.last_modified) > new Date(note.last_modified)
  ) {
    return {
      content: localNote.content,
      uniqueLinks: getUniqueLinks(localNote.content),
    };
  }
  return { content: note.content, uniqueLinks: getUniqueLinks(note.content) };
};

const getNote = async (name) => {
  const response = await db.select("SELECT * FROM notes WHERE name = $1", [
    name,
  ]);

  if (response.length > 0) {
    const allNotes = await db.select("SELECT * FROM notes");
    const recent = allNotes
      .sort((a, b) => b.recent_index - a.recent_index)
      .map((note) => note.name)
      .slice(0, 10);

    const note = await db.select(
      "UPDATE notes SET recent_notes = $1 WHERE id = $2; SELECT * FROM notes WHERE id = $2",
      [recent, response[0].id],
    );

    return {
      ...note[0],
      links: JSON.parse(note[0].links),
      backlinks: JSON.parse(note[0].backlinks),
      recent_notes: JSON.parse(note[0].recent_notes),
    };
  } else {
    const note = await db.select(
      "INSERT INTO notes (name, content, links, backlinks, last_modified, recent_index, base_url, id, recent_notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9); SELECT * FROM notes WHERE name = $1",
      [
        name,
        "",
        [],
        [],
        new Date().toUTCString(),
        new Date().getTime(),
        "/",
        urlsafe_key(name),
        [],
      ],
    );
    return {
      ...note[0],
      links: JSON.parse(note[0].links),
      backlinks: JSON.parse(note[0].backlinks),
      recent_notes: JSON.parse(note[0].recent_notes),
    };
  }
  return null;
};

const fetchRelatedNotes = async (dispatch, options) => {
  const { links, backlinks, recentLinks } = options;
  // console.log("caching related notes...");
  const relatedLinks = Array.from(
    new Set([...links, ...backlinks, ...recentLinks]),
  );
  for (const link of relatedLinks) {
    // only fetch if no version in localStorage
    if (!getLocalNote(link)) {
      getNote(link).then((note) => {
        if (note) {
          localStorage.setItem(link, JSON.stringify(note));
        }
      });
    }
  }
};

const updateDatabase = async (dispatch, options) => {
  try {
    const note = await db.select("SELECT * FROM notes WHERE id = $1", [
      options.state.note.id,
    ]);
    const current = note[0];

    const content = await invoke("sanitize_html", {
      text: options.state.note.content,
    });

    const removedLinks = list_diff(
      JSON.parse(current.links || "[]"),
      options.state.note.links,
    );
    const addedLinks = list_diff(
      options.state.note.links,
      JSON.parse(current.links || "[]"),
    );

    await db.execute(
      "UPDATE notes SET content = $1, last_modified = $2, recent_index = $3 WHERE id = $4",
      [
        content,
        options.state.note.last_modified,
        new Date().getTime(),
        options.state.note.id,
      ],
    );

    for (const link of removedLinks) {
      if (link) {
        const linked = await db.select("SELECT * FROM notes WHERE name = $1", [
          link,
        ]);

        if (linked.length > 0) {
          const linkedNote = linked[0];
          const backlinks = JSON.parse(linkedNote.backlinks || "[]");

          const updatedBacklinks = backlinks.filter(
            (bl) => bl !== options.state.note.name,
          );

          await db.execute("UPDATE notes SET backlinks = $1 WHERE name = $2", [
            updatedBacklinks,
            link,
          ]);
        }
      }
    }

    for (const link of addedLinks) {
      if (link) {
        const linked = await db.select("SELECT * FROM notes WHERE name = $1", [
          link,
        ]);

        if (linked.length === 0) {
          await db.execute(
            "INSERT INTO notes (name, content, links, backlinks, last_modified, recent_index, base_url, id, recent_notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            [
              link,
              "",
              [],
              [options.state.note.name],
              new Date().toUTCString(),
              new Date().getTime(),
              "/",
              urlsafe_key(link),
              [],
            ],
          );
        } else {
          const existingBacklinks = JSON.parse(linked[0].backlinks || "[]");

          if (!existingBacklinks.includes(options.state.note.name)) {
            existingBacklinks.push(options.state.note.name);
            await db.execute(
              "UPDATE notes SET backlinks = $1 WHERE name = $2",
              [JSON.stringify(existingBacklinks), link],
            );
          }
        }
      }
    }
    dispatch(SetStatus, new Date().toUTCString());
  } catch (err) {
    // case of an expired token, save it to local storage and load on boot
    const newState = {
      ...options.state,
      note: {
        ...options.state.note,
        last_modified: new Date().toUTCString(),
      },
    };
    localStorage.setItem(
      options.state.note.name,
      JSON.stringify(newState.note),
    );
    dispatch(SetStatus, "failed to save, please refresh.");
  }
};

const renderIcons = (dispatch, options) => {
  requestAnimationFrame(() => {
    feather.replace();
  });
};

const focusInput = (dispatch, options) => {
  requestAnimationFrame(() => {
    document.getElementById(options.id).focus();
  });
};

const attachCodeJar = (dispatch, options) => {
  requestAnimationFrame(() => {
    let timeout = null;
    var container = document.getElementById("container");
    var contentDiv = document.querySelector(".content-wrapper");
    const scrollTop = contentDiv.scrollTop;
    container.innerHTML = "";
    jar = CodeMirror(container, {
      value: options.content,
      lineNumbers: false,
      lineWrapping: true,
      viewportMargin: Infinity,
      autoCloseBrackets: true,
      autofocus: true,
      mode: "markdown",
    });
    if (options.cursorPos) {
      jar.setSelection(options.cursorPos, options.cursorPos, { scroll: true });
    }
    contentDiv.scrollTop = scrollTop;
    jar.on("change", function (cm, change) {
      dispatch(UpdateContent, {
        newContent: cm.getValue(),
        cursorPos: jar.getCursor(),
      });
      if (!(jar.getTokenTypeAt(jar.getCursor()) === "link")) {
        clearTimeout(timeout);
        timeout = setTimeout(function () {
          dispatch(DebounceSave);
        }, 700);
      }
    });
  });
};

const attachMarkdown = (dispatch, options) => {
  const { rawMD, uniqueLinks } = options;

  const convertedMarkdown = linkSub(rawMD, uniqueLinks);
  const html = converter.makeHtml(convertedMarkdown);
  // console.log(html);
  requestAnimationFrame(() => {
    const container = document.getElementById("container");
    container.innerHTML = html;
  });
};

const getLocalNote = (name) => {
  const note = JSON.parse(localStorage.getItem(name));
  return note ? note : null;
};

const lazyLoadNote = (dispatch, options) => {
  // check if there is a local version of the note
  const note = getLocalNote(options.state.route);
  if (note) {
    const content = note.content;
    const uniqueLinks = getUniqueLinks(content);
    attachMarkdown(dispatch, { rawMD: content, uniqueLinks });
  }
  // update state with local note, then
  dispatch(UpdateAndRevalidate, note ? note : null);
};

const getNoteFromServer = async (dispatch, options) => {
  const name = options.state.route;
  let note = options.state.note;
  let rawResponse = await getNote(name);
  if (rawResponse) {
    note = rawResponse;
    if (
      !options.useCaching ||
      options.nothingCached ||
      new Date(note.last_modified) > new Date(options.state.note.last_modified)
    ) {
      // console.log("Lazy load init");
      dispatch(UpdateNote, note);
    }
  }

  if (options.useCaching) {
    // caching logic
    localStorage.setItem(note.name, JSON.stringify(note));
    const { links, backlinks } = note;
    const recentLinks = note.recent_notes;
    fetchRelatedNotes(dispatch, { links, backlinks, recentLinks });
  }
};

// actions
const UpdateNote = (state, note) => {
  const newState = {
    ...state,
    note,
  };
  const content = note.content;
  const uniqueLinks = getUniqueLinks(content);
  const isEdit = state.view === "EDIT";
  return [
    newState,
    isEdit
      ? [attachCodeJar, { content }]
      : [attachMarkdown, { rawMD: content, uniqueLinks }],
    [renderIcons],
  ];
};

const DebounceSave = (state) => {
  const bareLinks = getBareLinks(state.note.content);
  const newState = {
    ...state,
    note: {
      ...state.note,
      last_modified: "saving",
      links: bareLinks,
      recent_notes: [
        state.note.name,
        ...state.note.recent_notes.filter((name) => name != state.note.name),
      ],
    },
  };
  return [newState, [updateDatabase, { state: newState }], [renderIcons]];
};

const UpdateAndRevalidate = (state, note) => {
  const newState = {
    ...state,
    note: note ? note : state.note,
  };

  return [
    newState,
    [
      getNoteFromServer,
      { state: newState, nothingCached: note ? false : true, useCaching: true },
    ],
    [renderIcons],
  ];
};

const UpdateContent = (state, { newContent, cursorPos }) => {
  const bareLinks = getBareLinks(newContent);

  return [
    {
      ...state,
      note: {
        ...state.note,
        content: newContent,
        last_modified: "saving",
        links: bareLinks,
        recent_notes: [
          state.note.name,
          ...state.note.recent_notes.filter((name) => name != state.note.name),
        ],
      },
      cursorPos,
    },
    [renderIcons],
  ];
};

const SetStatus = (state, status) => {
  return [
    {
      ...state,
      note: {
        ...state.note,
        last_modified: status,
        recent_notes: [
          state.note.name,
          ...state.note.recent_notes.filter((name) => name != state.note.name),
        ],
      },
    },
    [renderIcons],
  ];
};

const Edit = (state) => {
  const newState = {
    ...state,
    view: "EDIT",
  };

  return [
    newState,
    [
      attachCodeJar,
      { content: state.note.content, cursorPos: state.cursorPos },
    ],
    [renderIcons],
  ];
};

const View = (state) => {
  const rawMD = state.note.content;
  const bareLinks = getBareLinks(state.note.content);
  const uniqueLinks = getUniqueLinks(rawMD);
  const newState = {
    ...state,
    view: "VIEW",
    note: {
      ...state.note,
      last_modified: new Date().toUTCString(),
      content: rawMD,
      links: bareLinks,
      recent_notes: [
        state.note.name,
        ...state.note.recent_notes.filter((name) => name != state.note.name),
      ],
    },
  };
  return [
    newState,
    [attachMarkdown, { rawMD, uniqueLinks }],
    [updateDatabase, { state: newState }],
    [renderIcons],
  ];
};

const ToggleView = (state) => {
  if (state.view === "VIEW") {
    return Edit(state);
  }
  return View(state);
};

const ToggleRight = (state) => {
  const newState = {
    ...state,
    showRight: !state.showRight,
    note: {
      ...state.note,
    },
  };

  return [newState, [renderIcons]];
};

const ToggleLeft = (state) => {
  const newState = {
    ...state,
    showLeft: !state.showLeft,
    note: {
      ...state.note,
    },
  };

  return [newState, [renderIcons]];
};

const ToggleFocusMode = (state) => {
  const newState = {
    ...state,
    showLeft: !(state.showLeft || state.showRight),
    showRight: !(state.showLeft || state.showRight),
    note: {
      ...state.note,
    },
  };
  return [newState, [renderIcons]];
};

const UncollapseAndFocus = (state, type = "") => {
  const types = {
    ADD: {
      focusId: "new-input",
    },
    SEARCH: {
      focusId: "search-input",
    },
  };
  const newState = {
    ...state,
    showLeft: !state.showLeft,
    controls: {
      ...state.controls,
      active: type,
    },
    note: {
      ...state.note,
    },
  };
  const toFocus = types[type].focusId || "";
  return [
    newState,
    [renderIcons],
    toFocus ? [focusInput, { id: toFocus }] : null,
  ];
};

// VIEWS

// 0. Re-usable Modules

// toggle input OR icon

// set some value for the input on input change

// add event handlers to
// onchange
// check
// confirm

// Logic related to the control panel, search and add

const searchNotes = async (dispatch, options) => {
  const searchTerm = options.state.controls.SEARCH.inputValue;
  let links = [];

  const rawResponse = await db.select("SELECT * FROM notes");
  const config = {
    keys: [
      { name: "name", weight: 2 },
      { name: "content", weight: 1 },
    ],
    includeScore: true,
    threshold: 0.6,
    shouldSort: true,
  };

  const fuse = new Fuse(rawResponse, config);
  const results = fuse.search(searchTerm);

  if (results) {
    links = results.map((result) => result.item.name);
  }

  dispatch(UpdateSearchNotes, links);
};

const UpdateSearchNotes = (state, notes) => [
  {
    ...state,
    hasSearched: true,
    searchLinks: notes,
  },
  [renderIcons],
];

const GetSearchLinks = (state) => {
  return [state, [searchNotes, { state }], [renderIcons]];
};

const ControlModule = (state, type) => {
  const types = {
    SEARCH: {
      iconKey: "search",
      inputId: "search-input",
      placeholder: "Search...",
      onConfirm: GetSearchLinks,
    },
    ADD: {
      iconKey: "plus",
      inputId: "new-input",
      placeholder: "Add a Note",

      onConfirm: async () => {
        if (state.controls.ADD.inputValue !== "") {
          let note = await getNote(state.controls.ADD.inputValue);
          if (note) {
            window.location.replace(
              `${window.location.origin}#${state.controls.ADD.inputValue}`,
            );
            window.location.reload();
          }
        }
      },
    },
  };

  const open = (state) => {
    const newState = {
      ...state,
      controls: {
        ...state.controls,
        active: type,
        [type]: {
          inputValue: "",
        },
      },
    };
    return [newState, [renderIcons], [focusInput, { id: types[type].inputId }]];
  };

  const close = (state) => {
    const newState = {
      ...state,
      hasSearched: false,
      controls: {
        ...state.controls,
        active: "",
      },
    };
    return [newState, [renderIcons]];
  };

  const inputHandler = (state, event) => {
    if (event.key === "Enter") {
      return types[type].onConfirm;
    } else if (event.key === "Escape") {
      return close(state);
    }

    return {
      ...state,
      hasSearched: type === "SEARCH" ? false : state.hasSearched,
      controls: {
        ...state.controls,
        [type]: {
          inputValue: event.target.value,
        },
      },
    };
  };

  const isOpen = state.controls.active === type;

  if (isOpen) {
    return h("div", { class: "input-wrap" }, [
      h("input", {
        class: "input",
        id: types[type].inputId,
        placeholder: types[type].placeholder,
        onkeyup: inputHandler,
      }),
      h(
        "a",
        {
          class: "icon-wrap check",
          id: "check-search",
          onclick: types[type].onConfirm,
        },
        [h("i", { "data-feather": "check", class: "icon" })],
      ),
      h(
        "a",
        {
          class: "icon-wrap x-icon x",
          onclick: close,
        },
        [h("i", { "data-feather": "x", class: "icon" })],
      ),
    ]);
  }
  return h("a", { class: "icon-wrap", onclick: open }, [
    h("i", { "data-feather": types[type].iconKey, class: "icon" }),
  ]);
};

const ControlMessage = (props) => {
  const msg =
    props.hasSearched && props.searchLinks.length === 0
      ? "No search results"
      : null;
  if (msg) {
    return h("div", { class: "control-message" }, text(msg));
  } else {
    return h("div", {}, []);
  }
};

// Toggle List Module
const ToggleList = {
  init: (x) => x,
  toggle: (x) => !x,
  model: ({ getter, setter }) => {
    const Toggle = (state) =>
      setter(state, ToggleList.toggle(getter(state).value));

    return (state) => ({
      value: getter(state).value,
      tag: getter(state).tag,
      links: getter(state).links,
      hasTopBorder: getter(state).hasTopBorder,
      Toggle,
    });
  },
  view: (model) => {
    const topBorder = model.hasTopBorder ? "toggle-list-top" : "";
    if (model.links.length === 0) {
      return h("div", {}, []);
    }
    if (model.value) {
      return h("div", { class: `toggle-list ${topBorder}` }, [
        h("a", { class: "toggle-title collapsed", onclick: model.Toggle }, [
          h("div", { class: "title-tag" }, text(model.tag)),
          h("div", { class: "icon-wrap mlauto" }, [
            h("i", { "data-feather": "chevron-down", class: "icon" }),
          ]),
        ]),
      ]);
    }
    return h("div", { class: `toggle-list ${topBorder}` }, [
      h("a", { class: "toggle-title", onclick: model.Toggle }, [
        h("div", { class: "title-tag" }, text(model.tag)),
        h("a", { class: "icon-wrap mlauto toggle-chevron-active" }, [
          h("i", { "data-feather": "chevron-up", class: "icon" }),
        ]),
      ]),
      ...model.links.map((link) =>
        h("a", { href: `#${link}`, class: "toggle-link ellipsis" }, text(link)),
      ),
    ]);
  },
};

// List views
// do the border lines here.
const searchList = ToggleList.model({
  getter: (state) => ({
    value: state.collapseSearch,
    tag: "Search",
    links: state.searchLinks,
    hasTopBorder: false,
  }),
  setter: (state, toggleSearch) => [
    { ...state, collapseSearch: toggleSearch },
    [renderIcons],
  ],
});

const recentList = ToggleList.model({
  getter: (state) => ({
    value: state.collapseRecent,
    tag: "Recent",
    links: state.note.recent_notes,
    hasTopBorder: state.searchLinks.length > 0 ? true : false,
  }),
  setter: (state, toggleRecent) => [
    { ...state, collapseRecent: toggleRecent },
    [renderIcons],
  ],
});

const linksList = ToggleList.model({
  getter: (state) => ({
    value: state.collapseLinks,
    tag: "Links",
    links: state.note.links,
    hasTopBorder:
      !state.isMobile ||
      (state.isMobile &&
        state.searchLinks.length === 0 &&
        state.note.recent_notes.length === 0)
        ? false
        : true,
  }),
  setter: (state, toggleLinks) => [
    { ...state, collapseLinks: toggleLinks },
    [renderIcons],
  ],
});

const backlinksList = ToggleList.model({
  getter: (state) => ({
    value: state.collapseBacklinks,
    tag: "Backlinks",
    links: state.note.backlinks,
    hasTopBorder:
      state.note.links.length > 0 ||
      (state.isMobile &&
        (state.note.recent_notes.length || state.searchLinks.length))
        ? true
        : false,
  }),
  setter: (state, toggleBacklinks) => [
    { ...state, collapseBacklinks: toggleBacklinks },
    [renderIcons],
  ],
});

// 1. Central Section

const editBtn = (props) => {
  return h("div", {}, [
    h(
      "a",
      {
        class: "icon-wrap",
        onclick: View,
        alt: "View Note",
        title: "View Note",
      },
      [h("i", { "data-feather": "eye", class: "icon" })],
    ),
  ]);
};

const viewBtn = (props) => {
  return h(
    "a",
    { class: "icon-wrap", onclick: Edit, alt: "Edit Note", title: "Edit Note" },
    [h("i", { "data-feather": "edit-2", class: "icon" })],
  );
};

const central = (props) => {
  const oneExpandedSide = props.showLeft ? !props.showRight : props.showRight;
  const bothExpandedSides = props.showLeft && props.showRight;

  let centralWidth;
  let contentWidth;

  if (oneExpandedSide) {
    centralWidth = window.innerWidth - 280;
  } else if (bothExpandedSides) {
    centralWidth = window.innerWidth - 480;
  } else {
    centralWidth = window.innerWidth - 80;
  }

  contentWidth = centralWidth > 1182 ? 768 : centralWidth - 340;

  // shrink the content-wrap divs based on central width
  // 768, 480, 288

  return h(
    "div",
    { class: `central-pane`, style: { width: `${centralWidth}px` } },
    [
      h(
        "div",
        {
          class: `central-content-wrap`,
          style: { width: `${contentWidth}px` },
        },
        [
          h("div", { class: "title-bar" }, [
            h("div", { class: "titlebar-title" }, text(props.note.name)),
            h("div", { class: "titlebar-right" }, [
              props.view === "EDIT" ? editBtn(props) : viewBtn(props),
            ]),
          ]),
          h("div", { class: "content-wrapper" }, [
            h("div", { id: "container", class: "main" }),
          ]),
        ],
      ),
      h("div", { class: `footer`, style: { width: `${centralWidth}px` } }, [
        h(
          "div",
          {
            class: `footer-content-wrap`,
            style: { width: `${contentWidth}px` },
          },
          [
            h(
              "div",
              { class: "last-modified truncated" },
              text(`${getlastEdited(props.note.last_modified)}`),
            ),
          ],
        ),
      ]),
    ],
  );
};

// 2. Left Section

// left section
const left = (props) => {
  if (!props.showLeft) {
    return leftClose(props);
  } else {
    return leftOpen(props);
  }
};

// left close !showLeft
const leftClose = (props) => {
  return h("div", { class: "side-pane-collapsed left-pane" }, [
    h("div", { class: "space-area" }),
    h(
      "a",
      { class: "icon-wrap mlauto", onclick: [UncollapseAndFocus, "ADD"] },
      [h("i", { "data-feather": "plus", class: "icon" })],
    ),
    h(
      "a",
      { class: "icon-wrap mlauto", onclick: [UncollapseAndFocus, "SEARCH"] },
      [h("i", { "data-feather": "search", class: "icon" })],
    ),
    h("div", { class: "footer" }, [
      h("div", {}, [
        h("a", { class: "icon-wrap", onclick: ToggleLeft }, [
          h("i", { "data-feather": "chevrons-right", class: "icon" }),
        ]),
      ]),
    ]),
  ]);
};

// left open showLeft
const leftOpen = (props) => {
  return h("div", { class: "side-pane left-pane" }, [
    h("div", {
      class: "drag-area",
      "data-tauri-drag-region": "",
    }),
    h("div", { class: "control-wrap" }, [
      ControlModule(props, "ADD"),
      ControlModule(props, "SEARCH"),
      ControlMessage(props),
    ]),
    h("div", { class: "lc" }, [
      // needs to be wrapped otherwise hyperapp errors
      h("div", {}, [ToggleList.view(searchList(props))]),
      // needs to be wrapped otherwise hyperapp errors
      h("div", {}, [ToggleList.view(recentList(props))]),
    ]),
    h("div", { class: "footer" }, [
      h("a", { class: "icon-wrap mlauto", onclick: ToggleLeft }, [
        h("i", { "data-feather": "chevrons-left", class: "icon" }),
      ]),
    ]),
  ]);
};

// 3. Right Section

const right = (props) => {
  if (!props.showRight) {
    return rightClose(props);
  }
  return rightOpen(props);
};

// rightClose
const rightClose = (props) => {
  return h("div", { class: "side-pane-collapsed right-pane" }, [
    LinkNumberDec(props.note.links.length, false, true),
    LinkNumberDec(props.note.backlinks.length, true, true),
    h("div", { class: "footer" }, [
      h("a", { class: "icon-wrap", onclick: ToggleRight }, [
        h("i", { "data-feather": "chevrons-left", class: "icon" }),
      ]),
    ]),
  ]);
};

// rightOpen
const rightOpen = (props) => {
  return h("div", { class: "side-pane right-pane" }, [
    h("div", { class: "rc" }, [
      h("div", { class: "right-content-wrap" }, [
        h("div", {}, [ToggleList.view(linksList(props))]),
        h("div", {}, [ToggleList.view(backlinksList(props))]),
      ]),
    ]),
    h("div", { class: "link-desc" }, [
      LinkNumberDec(props.note.links.length, false, false),
      LinkNumberDec(props.note.backlinks.length, true, false),
    ]),
    h("div", { class: "footer" }, [
      h("div", {}, [
        h("a", { class: "icon-wrap", onclick: ToggleRight }, [
          h("i", { "data-feather": "chevrons-right", class: "icon" }),
        ]),
      ]),
    ]),
  ]);
};

// 4. Mobile Views

const mobileNav = (props) => {
  if (!props.showLeft) {
    return h("div", { class: "empty" });
  }
  return h("div", { class: "side-pane left-pane side-pane-mb" }, [
    h("div", {
      class: "drag-area",
      title: "Move window",
      "data-tauri-drag-region": "",
    }),
    h("div", { class: "control-wrap" }, [
      ControlModule(props, "ADD"),
      ControlModule(props, "SEARCH"),
      ControlMessage(props),
    ]),
    h("div", { class: "lc" }, [
      // needs to be wrapped otherwise hyperapp errors
      h("div", {}, [ToggleList.view(searchList(props))]),
      h("div", {}, [ToggleList.view(recentList(props))]),
      h("div", {}, [ToggleList.view(linksList(props))]),
      h("div", {}, [ToggleList.view(backlinksList(props))]),
    ]),
    h("div", { class: "link-desc" }, [
      LinkNumberDec(props.note.links.length, false, false),
      LinkNumberDec(props.note.backlinks.length, true, false),
    ]),
    h("div", { class: "footer footer-showleft-mb" }, [
      h("a", { class: "icon-wrap", onclick: ToggleLeft }, [
        h("i", { "data-feather": "chevrons-left", class: "icon" }),
      ]),
    ]),
  ]);
};

// main mb
const mobileMain = (props) => {
  const showContent = props.showLeft ? "content-mb-closed" : "content-mb-open";
  return h("div", { class: `${showContent}` }, [
    h("div", { class: "title-bar title-bar-mb" }, [
      h("div", { class: "titlebar-title" }, text(props.note.name)),
      h("div", { class: "titlebar-right" }, [
        props.view === "EDIT" ? editBtn(props) : viewBtn(props),
      ]),
    ]),
    h("div", { class: `central-mb` }, [
      h("div", { class: "content-wrapper" }, [
        h("div", { id: "container", class: "main" }),
      ]),
    ]),
    h("div", { class: `footer footer-mb` }, [
      h("a", { class: "icon-wrap", onclick: ToggleLeft }, [
        h("i", { "data-feather": "chevrons-right", class: "icon" }),
      ]),
      h(
        "div",
        { class: "last-modified mlauto last-modified-mb truncated " },
        text(`${getlastEdited(props.note.last_modified)}`),
      ),
    ]),
  ]);
};

// 5. Misc Component Views

const LinkNumberDec = (length, backlinks = true, collapsed) => {
  if (collapsed) {
    return h("div", { class: "link-num-dec-collapsed" }, text(`${length}`));
  }
  return h(
    "div",
    { class: "link-num-dec" },
    text(`${length} ${backlinks ? "back" : ""}link${length !== 1 ? "s" : ""}`),
  );
};

const main = (props) => {
  return h(
    "div",
    { class: "wrapper" },
    props.isMobile
      ? [mobileNav(props), mobileMain(props)]
      : [left(props), central(props), right(props)],
  );
};

// SUBSCRIPTIONS

// S1. mobile switch handlers

const _onresize = (dispatch, options) => {
  const handler = () => dispatch(options.action);
  addEventListener("resize", handler);
  requestAnimationFrame(handler);
  return () => removeEventListener("resize", handler);
};

const onresize = (action) => [_onresize, { action }];

const ResizeHandler = (state) => {
  // console.log("Resize triggered...", window.innerWidth, window.innerHeight);
  const newState = {
    ...state,
    isMobile: window.innerWidth < 768,
    showLeft: state.showLeft,
  };
  const rawMD = newState.note.content;
  const uniqueLinks = getUniqueLinks(rawMD);
  const lastEdited = newState.note.last_modified;
  requestAnimationFrame(() => {
    document.getElementById("container").innerHTML = "";
  });
  if (newState.view === "VIEW") {
    return [newState, [attachMarkdown, { rawMD, uniqueLinks }], [renderIcons]];
  }
  return [
    newState,
    [
      attachCodeJar,
      { content: newState.note.content, cursorPos: newState.cursorPos },
    ],
    [renderIcons],
  ];
};

// S2. hash routing handlers
const _onhashchange = (dispatch, options) => {
  const handler = () => dispatch(options.action, location.hash);
  addEventListener("hashchange", handler);
  requestAnimationFrame(handler);
  return () => removeEventListener("hashchange", handler);
};

const onhashchange = (action) => [_onhashchange, { action }];

const HashHandler = (state, hash) => {
  const newState = {
    ...state,
    route:
      hash === ""
        ? new Date().toLocaleDateString("fr-CA")
        : decodeURI(hash.substring(1)),
  };
  const useCaching = false;
  return [
    newState,
    useCaching
      ? [
          lazyLoadNote,
          {
            state: newState,
          },
        ]
      : [getNoteFromServer, { state: newState, useCaching }],
    [renderIcons],
  ];
};

// S3. keyboard shortcut handlers
const _onkeydown = (dispatch, options) => {
  const handler = (event) => dispatch(options.action, event);
  addEventListener("keydown", handler);
  requestAnimationFrame(handler);
  return () => removeEventListener("keydown", handler);
};

const onkeydown = (action) => [_onkeydown, { action }];

const KeydownHandler = (state, event) => {
  if (event.metaKey || event.ctrlKey) {
    if (event.key === "i") {
      return ToggleView(state);
    } else if (event.key === "j") {
      return ToggleFocusMode(state);
    }
  }
  return [state, [renderIcons]];
};

const initState = {
  view: "EDIT",
  note: {
    name: "Loading",
    content: "Loading...",
    links: [],
    backlinks: [],
    base_url: `https://${window.location.host}/`,
    recent_index: new Date().getTime(),
    last_modified: new Date().toISOString(),
    recent_notes: [],
  },
  cursorPos: null,
  controls: {
    active: "",
    SEARCH: {
      inputValue: "",
    },
    ADD: {
      inputValue: "",
    },
  },
  hasSearched: false,
  searchLinks: [],
  showLeft: Math.min(window.innerWidth) < 768 ? false : true,
  showRight: true,
  collapseRecent: false,
  collapseLinks: false,
  collapseBacklinks: false,
  collapseSearch: false,
  isMobile: Math.min(window.innerWidth, window.innerHeight) < 768,
};

const initSql = async () => {
  await db.execute(
    "CREATE TABLE IF NOT EXISTS notes (name TEXT NOT NULL, content TEXT, links, backlinks, last_modified TEXT, recent_index REAL, base_url TEXT, id TEXT PRIMARY KEY, recent_notes);",
  );
};

app({
  init: [initState, [renderIcons], [initSql]],
  view: (state) => main(state),
  subscriptions: (state) => [
    onhashchange(HashHandler),
    onresize(ResizeHandler),
    onkeydown(KeydownHandler),
  ],
  node: document.getElementById("app"),
});
