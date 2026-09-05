export const bytes = (n) => {
  if (n === 0 || n == null) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1)
  const v = n / Math.pow(1024, i)
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

export const timeAgo = (iso) => {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`
  const d = Math.floor(s / 86400)
  if (d === 1) return 'yesterday'
  if (d < 30) return `${d} days ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export const dateTime = (iso) =>
  new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })

export const dateOnly = (iso) =>
  new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

export const clockTime = (iso) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })

// 365-day retention, per the S3 lifecycle rule
export const retentionDaysLeft = (createdAt) => {
  const elapsed = (Date.now() - new Date(createdAt).getTime()) / 86400000
  return Math.max(0, Math.ceil(365 - elapsed))
}

export const initials = (name = '') =>
  name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

export const inr = (n) => `₹${n.toLocaleString('en-IN')}`
