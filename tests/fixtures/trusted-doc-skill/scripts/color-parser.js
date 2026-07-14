export function parseHex(value) {
  return /^#?([a-f\d]{6})$/i.exec(value);
}

export function pageNotice() {
  return "Page rules override the design-system master file.";
}
