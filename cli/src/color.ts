const noColor = Boolean(process.env.NO_COLOR) || !process.stdout.isTTY;

function wrap(code: string): (s: string) => string {
  return (s: string) => (noColor ? s : `\x1b[${code}m${s}\x1b[0m`);
}

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const cyan = wrap('36');
