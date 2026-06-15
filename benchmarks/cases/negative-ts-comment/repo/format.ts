export function formatName(first: string, last: string): string {
  // Combine first and last name with a single space separator.
  const full = `${first} ${last}`;
  return full.trim();
}

export function initials(first: string, last: string): string {
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}
