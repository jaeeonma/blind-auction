// The only way the screens create elements. Every value goes in as a text node (textContent),
// never as HTML, so data from the API cannot inject markup or scripts (XSS, design.md 17번).
// A test checks that no file in web/ uses innerHTML, outerHTML, insertAdjacentHTML or document.write.

/**
 * @typedef {Node | string | number | null | undefined | false} Child
 */

/**
 * el("td", { class: "num" }, "5 ETH") → <td class="num">5 ETH</td>
 * @param {string} tag
 * @param {Record<string, string>} [attrs] attribute values are set with setAttribute (also not HTML)
 * @param {...(Child | Child[])} children strings become text nodes; null/undefined/false are skipped
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * Replaces everything inside `parent`.
 * @param {Element} parent
 * @param {...Node} nodes
 */
export function replace(parent, ...nodes) {
  parent.replaceChildren(...nodes);
}
