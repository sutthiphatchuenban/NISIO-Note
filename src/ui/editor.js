import { Compartment, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";

// The note UI keeps its text/selection API while CodeMirror owns the document
// tree, undo history, and viewport rendering. No full-size hidden textarea.
export function createEditor(placeholder) {
  const root = document.createElement("div");
  root.id = placeholder.id;
  placeholder.replaceWith(root);
  const preferences = new Compartment();
  let config = { wrap: false, spellcheck: false, tabSize: 2 };
  let cachedDoc = null;
  let cachedText = "";
  const extensions = () => [
    config.wrap ? EditorView.lineWrapping : [],
    EditorState.tabSize.of(config.tabSize),
    EditorView.contentAttributes.of({
      spellcheck: String(config.spellcheck),
      "aria-label": root.getAttribute("aria-label") || "Note content",
      autocapitalize: "off", autocorrect: "off",
    }),
  ];
  const state = (doc) => EditorState.create({ doc, extensions: [
    history(), keymap.of([...defaultKeymap, ...historyKeymap]),
    preferences.of(extensions()),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) root.dispatchEvent(new Event("editor-change"));
      if (update.selectionSet) root.dispatchEvent(new Event("editor-selection"));
    }),
  ] });
  const view = new EditorView({ state: state(""), parent: root });
  const bound = (position) => Math.max(0, Math.min(view.state.doc.length, position));
  const props = {
    value: {
      get() {
        if (cachedDoc !== view.state.doc) {
          cachedDoc = view.state.doc;
          cachedText = cachedDoc.toString();
        }
        return cachedText;
      },
      set(text) { view.setState(state(String(text))); },
    },
    selectionStart: { get: () => view.state.selection.main.from },
    selectionEnd: { get: () => view.state.selection.main.to },
    textLength: { get: () => view.state.doc.length },
    lineCount: { get: () => view.state.doc.lines },
    firstLine: { get: () => view.state.doc.line(1).text },
    hasFocus: { get: () => view.hasFocus },
  };
  for (const key of ["scrollTop", "scrollLeft"]) {
    props[key] = { get: () => view.scrollDOM[key], set(value) { view.scrollDOM[key] = value; } };
  }
  for (const key of ["scrollHeight", "scrollWidth", "clientHeight", "clientWidth"]) {
    props[key] = { get: () => view.scrollDOM[key] };
  }
  Object.defineProperties(root, props);
  root.focus = () => view.focus();
  root.setSelectionRange = (start, end) => view.dispatch({
    selection: EditorSelection.single(bound(start), bound(end)),
  });
  root.select = () => root.setSelectionRange(0, view.state.doc.length);
  root.setRangeText = (text, start, end, mode = "end") => {
    text = String(text).replace(/\r\n?/g, "\n");
    const from = bound(start), to = Math.max(from, bound(end));
    view.dispatch({
      changes: { from, to, insert: text },
      selection: EditorSelection.single(mode === "select" ? from : from + text.length, from + text.length),
      scrollIntoView: true,
      annotations: Transaction.userEvent.of("input"),
    });
  };
  root.undo = () => undo(view);
  root.redo = () => redo(view);
  root.lineAt = (position) => view.state.doc.lineAt(bound(position)).number - 1;
  root.lineStart = (line) => view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, line + 1))).from;
  root.revealRange = (start, end) => {
    root.setSelectionRange(start, end);
    view.dispatch({ effects: EditorView.scrollIntoView(bound(start), { y: "center" }) });
  };
  root.configure = (settings) => {
    const next = { wrap: !!settings.wrap, spellcheck: !!settings.spellcheck, tabSize: settings.tabSize || 2 };
    if (JSON.stringify(next) !== JSON.stringify(config)
      || view.contentDOM.getAttribute("aria-label") !== root.getAttribute("aria-label")) {
      config = next;
      view.dispatch({ effects: preferences.reconfigure(extensions()) });
    }
    view.requestMeasure();
  };
  root.measure = () => view.requestMeasure();
  root.whenMeasured = () => new Promise((resolve) => {
    view.requestMeasure();
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
  root.renderedLines = () => view.contentDOM.querySelectorAll(".cm-line").length;
  view.scrollDOM.addEventListener("scroll", () => root.dispatchEvent(new Event("scroll")), { passive: true });
  return root;
}
