// Promise-based controller so a web-mode folder picker modal can resolve
// transport.pickDirectory().

type Resolver = (path: string | undefined) => void;

let resolver: Resolver | null = null;
const listeners = new Set<(open: boolean) => void>();

export function requestDirectory(): Promise<string | undefined> {
  // if one is already pending, cancel it
  resolver?.(undefined);
  return new Promise<string | undefined>((resolve) => {
    resolver = resolve;
    listeners.forEach((l) => l(true));
  });
}

export function resolveDirectory(path: string | undefined) {
  const r = resolver;
  resolver = null;
  listeners.forEach((l) => l(false));
  r?.(path);
}

export function subscribePicker(cb: (open: boolean) => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
