/** Tiny DOM helpers shared by the menu code (ui.ts and community-ui.ts). */

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '', parent?: HTMLElement): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    parent?.appendChild(e);
    return e;
}

export function button(label: string, cls: string, parent: HTMLElement, onClick: () => void): HTMLButtonElement {
    const b = h('button', cls, label, parent);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
}
