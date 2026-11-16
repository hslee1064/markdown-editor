"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@tiptap/core");
const starter_kit_1 = __importDefault(require("@tiptap/starter-kit"));
const extension_link_1 = __importDefault(require("@tiptap/extension-link"));
const extension_image_1 = __importDefault(require("@tiptap/extension-image"));
const extension_task_list_1 = __importDefault(require("@tiptap/extension-task-list"));
const extension_task_item_1 = __importDefault(require("@tiptap/extension-task-item"));
const extension_placeholder_1 = __importDefault(require("@tiptap/extension-placeholder"));
const tiptap_markdown_1 = require("tiptap-markdown");
const vscode = acquireVsCodeApi();
let baseUri = '';
const isRelative = (src) => !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src);
// Display relative images via the webview URI, but keep the original path in the document.
const LocalImage = extension_image_1.default.extend({
    renderHTML({ HTMLAttributes }) {
        const src = HTMLAttributes.src;
        const attrs = { ...HTMLAttributes };
        if (src && baseUri && isRelative(src))
            attrs.src = baseUri + '/' + src.replace(/^\.\//, '');
        return ['img', attrs];
    },
});
const source = document.getElementById('source');
const main = document.querySelector('.main');
let lastText = ''; // last markdown known to be in sync with the host document
let timer;
const send = (text) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
        if (text === lastText)
            return;
        lastText = text;
        vscode.postMessage({ type: 'edit', text });
    }, 150);
};
const getMarkdown = () => editor.storage.markdown.getMarkdown();
const editor = new core_1.Editor({
    element: document.getElementById('wysiwyg'),
    extensions: [
        starter_kit_1.default,
        extension_link_1.default.configure({ openOnClick: false, autolink: true }),
        LocalImage,
        extension_task_list_1.default,
        extension_task_item_1.default.configure({ nested: true }),
        extension_placeholder_1.default.configure({ placeholder: "Type '#' + space for a heading, '-' + space for a list…" }),
        tiptap_markdown_1.Markdown.configure({ html: false, linkify: true, transformPastedText: true, transformCopiedText: true, tightLists: true }),
    ],
    onUpdate: () => send(getMarkdown()),
    onSelectionUpdate: () => updateToolbar(),
    onTransaction: () => updateToolbar(),
});
const setFromHost = (text) => {
    lastText = text;
    if (source.value !== text) {
        const { selectionStart: s, selectionEnd: e } = source;
        source.value = text;
        source.setSelectionRange(s, e);
    }
    // Avoid resetting the cursor when the host just echoes our own edit.
    if (getMarkdown() !== text)
        editor.commands.setContent(text, false);
};
window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'init')
        baseUri = msg.baseUri ?? '';
    if (msg.type === 'init' || msg.type === 'update')
        setFromHost(msg.text);
});
source.addEventListener('input', () => send(source.value));
source.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        source.setRangeText('  ', source.selectionStart, source.selectionEnd, 'end');
        send(source.value);
    }
});
// Toolbar
const commands = {
    bold: () => editor.chain().focus().toggleBold().run(),
    italic: () => editor.chain().focus().toggleItalic().run(),
    strike: () => editor.chain().focus().toggleStrike().run(),
    code: () => editor.chain().focus().toggleCode().run(),
    h1: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    h2: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    h3: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    bullet: () => editor.chain().focus().toggleBulletList().run(),
    ordered: () => editor.chain().focus().toggleOrderedList().run(),
    task: () => editor.chain().focus().toggleTaskList().run(),
    quote: () => editor.chain().focus().toggleBlockquote().run(),
    codeblock: () => editor.chain().focus().toggleCodeBlock().run(),
    hr: () => editor.chain().focus().setHorizontalRule().run(),
    link: () => {
        if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run();
            return;
        }
        linkBar.hidden = false;
        linkInput.value = 'https://';
        linkInput.focus();
        linkInput.select();
    },
};
const activeChecks = {
    bold: () => editor.isActive('bold'), italic: () => editor.isActive('italic'), strike: () => editor.isActive('strike'),
    code: () => editor.isActive('code'), h1: () => editor.isActive('heading', { level: 1 }), h2: () => editor.isActive('heading', { level: 2 }),
    h3: () => editor.isActive('heading', { level: 3 }), bullet: () => editor.isActive('bulletList'), ordered: () => editor.isActive('orderedList'),
    task: () => editor.isActive('taskList'), quote: () => editor.isActive('blockquote'), codeblock: () => editor.isActive('codeBlock'), link: () => editor.isActive('link'),
};
function updateToolbar() {
    document.querySelectorAll('[data-cmd]').forEach(b => b.classList.toggle('on', !!activeChecks[b.dataset.cmd]?.()));
}
const linkBar = document.getElementById('linkbar');
const linkInput = document.getElementById('linkinput');
linkInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        e.preventDefault();
        const href = linkInput.value.trim();
        if (href)
            editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
        linkBar.hidden = true;
    }
    else if (e.key === 'Escape') {
        linkBar.hidden = true;
        editor.commands.focus();
    }
});
const setView = (view) => {
    main.className = 'main ' + view;
    document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('active', x.dataset.view === view));
    document.querySelector('.format').classList.toggle('disabled', view === 'source');
    vscode.setState({ view });
};
document.querySelector('.toolbar').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b)
        return;
    if (b.dataset.cmd)
        commands[b.dataset.cmd]();
    else if (b.dataset.view)
        setView(b.dataset.view);
});
// Keep editor selection when clicking toolbar buttons.
document.querySelector('.toolbar').addEventListener('mousedown', e => {
    if (e.target.closest('button'))
        e.preventDefault();
});
document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k' && main.classList.contains('wysiwyg')) {
        e.preventDefault();
        commands.link();
    }
});
setView(vscode.getState()?.view ?? 'wysiwyg');
vscode.postMessage({ type: 'ready' });
//# sourceMappingURL=main.js.map