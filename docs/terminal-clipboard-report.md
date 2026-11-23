# Terminal clipboard: what the actions actually do

Run: 2026-11-23T06:12:27.957Z against http://127.0.0.1:5173 (Chromium, headless, clipboard permission granted).
Verdict: **PASS**

## Checks

| Check | Result | Detail |
| --- | --- | --- |
| a drag over three words selects three words, not the transcript | pass | DOM selection "bravo charlie delta" of 218 mirrored characters |
| the transcript mirror is unselectable, so no drag can pick the pane up | pass | computed user-select on [data-testid="terminal-output"] = none |
| Copy puts exactly the dragged words on the clipboard | pass | clipboard={"ok":true,"length":19,"head":"bravo charlie delta","tail":"bravo charlie delta"} expected 19 chars "bravo charlie delta" notice="Copied 19 characters." |
| Copy does not copy the whole transcript | pass | clipboard 19 chars vs mirrored transcript 218 chars |
| the highlight survives a click on Copy | pass | highlight rectangles before=2 mousedown=2 after click=2 (focus now textarea.xterm-helper-textarea) |
| a second Copy still has the selection to copy | pass | clipboard={"ok":true,"length":19,"head":"bravo charlie delta","tail":"bravo charlie delta"} notice="Copied 19 characters." |
| Ctrl+C copies the selection | pass | clipboard={"ok":true,"length":19,"head":"bravo charlie delta","tail":"bravo charlie delta"} notice="Copied 19 characters." events=[] |
| Ctrl+C is not silent: the document sees a copy event or the pane explains itself | pass | events=[] notice="Copied 19 characters." |
| Ctrl+X copies the selection | pass | clipboard={"ok":true,"length":19,"head":"bravo charlie delta","tail":"bravo charlie delta"} events=[] |
| Cut copies the selection and clears only the highlight | pass | clipboard={"ok":true,"length":19,"head":"bravo charlie delta","tail":"bravo charlie delta"} highlights after=0 notice="Copied 19 characters and cleared the selection (the shell's scrollback is untouched)." |
| a drag that leaves the terminal cannot put the transcript on the clipboard | pass | clipboard 51 chars vs mirrored transcript 280; mirror in DOM selection: false; notice="Copied 51 characters." |
| Paste goes to the active shell only | pass | notice="Pasted 22 characters." tabs=[{"tabId":"shell-1","hasSentinel":true},{"tabId":"shell-2","hasSentinel":false}] |
| Clear empties the pane and leaves the clipboard alone | pass | before={"ok":true,"length":22,"head":"SENTINEL-BEFORE-ACTION","tail":"SENTINEL-BEFORE-ACTION"} after={"ok":true,"length":22,"head":"SENTINEL-BEFORE-ACTION","tail":"SENTINEL-BEFORE-ACTION"} notice="Terminal cleared." |

## Raw measurements

```json
{
  "boot": "ready, shell connected",
  "transcriptLength": 109,
  "drag": {
    "expected": "bravo charlie delta",
    "afterDrag": {
      "domSelection": "bravo charlie delta",
      "domSelectionLength": 19,
      "mirrorInSelection": false,
      "mirrorLength": 218,
      "mirrorUserSelect": "none",
      "activeElement": "textarea.xterm-helper-textarea",
      "activeInsideTerminal": true,
      "highlightRects": 2
    }
  },
  "copy": {
    "notice": "Copied 19 characters.",
    "clipboard": {
      "ok": true,
      "length": 19,
      "head": "bravo charlie delta",
      "tail": "bravo charlie delta"
    },
    "events": [],
    "selection": {
      "domSelection": "",
      "domSelectionLength": 0,
      "mirrorInSelection": false,
      "mirrorLength": 280,
      "mirrorUserSelect": "none",
      "activeElement": "textarea.xterm-helper-textarea",
      "activeInsideTerminal": true,
      "highlightRects": 0
    }
  },
  "selectionAcrossClick": {
    "beforeClick": {
      "domSelection": "bravo charlie delta",
      "domSelectionLength": 19,
      "mirrorInSelection": false,
      "mirrorLength": 280,
      "mirrorUserSelect": "none",
      "activeElement": "textarea.xterm-helper-textarea",
      "activeInsideTerminal": true,
      "highlightRects": 2
    },
    "afterMouseDown": {
      "domSelection": "",
      "domSelectionLength": 0,
      "mirrorInSelection": false,
      "mirrorLength": 280,
      "mirrorUserSelect": "none",
      "activeElement": "button.inline-flex items-center justify-center ",
      "activeInsideTerminal": false,
      "highlightRects": 2
    },
    "afterClick": {
      "domSelection": "",
      "domSelectionLength": 0,
      "mirrorInSelection": false,
      "mirrorLength": 280,
      "mirrorUserSelect": "none",
      "activeElement": "textarea.xterm-helper-textarea",
      "activeInsideTerminal": true,
      "highlightRects": 2
    }
  },
  "copyWithoutSelection": {
    "notice": "Copied 19 characters.",
    "clipboard": {
      "ok": true,
      "length": 19,
      "head": "bravo charlie delta",
      "tail": "bravo charlie delta"
    },
    "events": [],
    "selection": {
      "domSelection": "",
      "domSelectionLength": 0,
      "mirrorInSelection": false,
      "mirrorLength": 280,
      "mirrorUserSelect": "none",
      "activeElement": "textarea.xterm-helper-textarea",
      "activeInsideTerminal": true,
      "highlightRects": 2
    }
  },
  "ctrlC": {
    "notice": "Copied 19 characters.",
    "clipboard": {
      "ok": true,
      "length": 19,
      "head": "bravo charlie delta",
      "tail": "bravo charlie delta"
    },
    "events": [],
    "selection": {
      "domSelection": "",
      "domSelectionLength": 0,
      "mirrorInSelection": false,
      "mirrorLength": 280,
      "mirrorUserSelect": "none",
      "activeElement": "textarea.xterm-helper-textarea",
      "activeInsideTerminal": true,
      "highlightRects": 2
    }
  },
  "ctrlX": {
    "notice": "Copied 19 characters and cleared the selection (the shell's scrollback is untouched).",
    "clipboard": {
      "ok": true,
      "length": 19,
      "head": "bravo charlie delta",
      "tail": "bravo charlie delta"
    },
    "events": [],
    "selection": {
      "domSelection": "",
      "domSelectionLength": 0,
      "mirrorInSelection": false,
      "mirrorLength": 280,
      "mirrorUserSelect": "none",
      "activeElement": "textarea.xterm-helper-textarea",
      "activeInsideTerminal": true,
      "highlightRects": 0
    }
  },
  "cut": {
    "notice": "Copied 19 characters and cleared the selection (the shell's scrollback is untouched).",
    "clipboard": {
      "ok": true,
      "length": 19,
      "head": "bravo charlie delta",
      "tail": "bravo charlie delta"
    },
    "events": [],
    "selection": {
      "domSelection": "",
      "domSelectionLength": 0,
      "mirrorInSelection": false,
      "mirrorLength": 280,
      "mirrorUserSelect": "none",
      "activeElement": "textarea.xterm-helper-textarea",
      "activeInsideTerminal": true,
      "highlightRects": 0
    }
  },
  "dragOutOfTerminal": {
    "selection": {
      "domSelection": "ha bravo charlie delta echo\n/workspace ⇒ \n\n\n\n\n\n\n\n\n\n",
      "domSelectionLength": 51,
      "mirrorInSelection": false,
      "mirrorLength": 280,
      "mirrorUserSelect": "none",
      "activeElement": "textarea.xterm-helper-textarea",
      "activeInsideTerminal": true,
      "highlightRects": 3
    },
    "copy": {
      "notice": "Copied 51 characters.",
      "clipboard": {
        "ok": true,
        "length": 51,
        "head": "ha bravo charlie delta echo\n/workspace ⇒",
        "tail": "arlie delta echo\n/workspace ⇒ \n\n\n\n\n\n\n\n\n\n"
      },
      "events": [],
      "selection": {
        "domSelection": "",
        "domSelectionLength": 0,
        "mirrorInSelection": false,
        "mirrorLength": 280,
        "mirrorUserSelect": "none",
        "activeElement": "textarea.xterm-helper-textarea",
        "activeInsideTerminal": true,
        "highlightRects": 3
      }
    }
  },
  "tabs": 2,
  "paste": {
    "notice": "Pasted 22 characters.",
    "clipboard": {
      "ok": true,
      "length": 22,
      "head": "SENTINEL-BEFORE-ACTION",
      "tail": "SENTINEL-BEFORE-ACTION"
    },
    "events": [],
    "selection": {
      "domSelection": "",
      "domSelectionLength": 0,
      "mirrorInSelection": false,
      "mirrorLength": 466,
      "mirrorUserSelect": "none",
      "activeElement": "textarea.xterm-helper-textarea",
      "activeInsideTerminal": true,
      "highlightRects": 0
    },
    "tabs": [
      {
        "tabId": "shell-1",
        "hasSentinel": true
      },
      {
        "tabId": "shell-2",
        "hasSentinel": false
      }
    ]
  },
  "clear": {
    "beforeClear": {
      "ok": true,
      "length": 22,
      "head": "SENTINEL-BEFORE-ACTION",
      "tail": "SENTINEL-BEFORE-ACTION"
    },
    "afterClear": {
      "ok": true,
      "length": 22,
      "head": "SENTINEL-BEFORE-ACTION",
      "tail": "SENTINEL-BEFORE-ACTION"
    },
    "clearNotice": "Terminal cleared."
  }
}
```

Evidence: `docs/evidence/terminal-clipboard.png`, `docs/evidence/terminal-clipboard.txt`.
