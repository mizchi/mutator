export function canEdit(role) {
  return role === 'admin' || role === 'owner';
}
