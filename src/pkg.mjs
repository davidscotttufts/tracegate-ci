// One pure helper shared by the recorder (which runs inside test workers and
// loads node builtins only) and the dependency rule (deps.mjs).

/**
 * Repo-relative package root of an absolute path inside node_modules, else null.
 * Null also for a dot directory (`.vite`'s pre-bundled deps, `.pnpm`): a module
 * there cannot be traced to its package, and the recorder then records no
 * package list at all, which turns the dependency rule off for that file. Pure.
 */
export function pkgOf(abs, root) {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const i = abs.lastIndexOf('/node_modules/');
  if (i < 0 || !abs.startsWith(prefix)) return null;
  const rest = abs.slice(i + '/node_modules/'.length).split('/');
  const name = rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1] ?? ''}` : rest[0];
  if (!name || name.startsWith('.')) return null;
  return `${abs.slice(prefix.length, i)}${i > prefix.length - 1 ? '/' : ''}node_modules/${name}`.replace(/^\//, '');
}
