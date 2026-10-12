/** macOS shell paths, also usable as literal file references in CLI harnesses. */
export function terminalFilePaths(paths: string[]): string {
  if (
    !paths.length ||
    paths.some(
      (path) =>
        !path.startsWith('/') ||
        Array.from(path).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    )
  )
    throw new Error('Drop local files with valid filesystem paths.');
  return (
    paths
      .map((path) =>
        /^[a-zA-Z0-9_./:-]+$/.test(path) ? path : "'" + path.replaceAll("'", "'\"'\"'") + "'",
      )
      .join(' ') + ' '
  );
}
