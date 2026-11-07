import template from "./ui/index.html" with { type: "text" };
import style from "./ui/style.css" with { type: "text" };
import script from "./ui/app.bundle.js" with { type: "text" };

/**
 * The whole renderer is inlined so the app can run from a single HTML string.
 * That keeps the compiled binary self-contained without a server or CDN.
 */
export function buildHtml(): string {
  return (template as unknown as string)
    .replace("/*__STYLE__*/", () => style as unknown as string)
    .replace("/*__APP__*/", () => script as unknown as string);
}
