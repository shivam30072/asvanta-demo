import { useEffect } from 'react'
import { STATUS } from '../store'
import * as I from './Icons'

export const StatusChip = ({ status, size = 'md' }) => {
  const s = STATUS[status] || STATUS.draft
  return (
    <span className={`chip ${s.cls} ${size === 'sm' ? 'text-[11px] px-2 py-0.5' : ''}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot} ${status === 'uploading' ? 'animate-pulse' : ''}`} />
      {s.label}
    </span>
  )
}

export const PriorityChip = ({ priority }) =>
  priority === 'Urgent' ? (
    <span className="chip bg-rose-50 text-rose-600">
      <I.Zap size={12} /> Urgent
    </span>
  ) : (
    <span className="chip bg-slate-100 text-slate-500">Routine</span>
  )

export const Avatar = ({ initials, className = '', size = 'md' }) => {
  const dims = size === 'sm' ? 'h-8 w-8 text-[11px]' : size === 'lg' ? 'h-12 w-12 text-base' : 'h-9 w-9 text-xs'
  return (
    <div className={`${dims} shrink-0 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white font-semibold grid place-items-center ${className}`}>
      {initials}
    </div>
  )
}

export const Progress = ({ value, className = '', tone = 'brand' }) => {
  const tones = { brand: 'bg-brand-600', green: 'bg-emerald-500', red: 'bg-rose-500', amber: 'bg-amber-500' }
  return (
    <div className={`h-1.5 w-full rounded-full bg-slate-100 overflow-hidden ${className}`}>
      <div className={`h-full rounded-full transition-all duration-300 ${tones[tone]}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  )
}

export const Modal = ({ open, onClose, children, width = 'max-w-lg', title, subtitle, icon }) => {
  useEffect(() => {
    if (!open) return
    const h = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', h)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className={`relative w-full ${width} card animate-scale-in max-h-[88vh] flex flex-col overflow-hidden`}>
        {title && (
          <div className="flex items-start gap-3 px-6 pt-5 pb-4 border-b border-slate-100">
            {icon && <div className="h-10 w-10 rounded-xl bg-brand-50 text-brand-600 grid place-items-center shrink-0">{icon}</div>}
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold text-slate-900">{title}</h3>
              {subtitle && <p className="text-[13px] text-slate-500 mt-0.5">{subtitle}</p>}
            </div>
            <button onClick={onClose} className="btn-ghost h-8 w-8 rounded-lg -mr-2 -mt-1">
              <I.X size={16} />
            </button>
          </div>
        )}
        <div className="overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}

export const Toasts = ({ toasts, onDismiss }) => (
  <div className="fixed bottom-6 right-6 z-[60] flex flex-col gap-2.5 w-[340px]">
    {toasts.map((t) => (
      <div key={t.id} className="card px-4 py-3 flex items-start gap-3 animate-fade-up shadow-lg">
        <div
          className={`h-8 w-8 rounded-lg grid place-items-center shrink-0 ${
            t.kind === 'error' ? 'bg-rose-50 text-rose-600' : t.kind === 'info' ? 'bg-brand-50 text-brand-600' : 'bg-emerald-50 text-emerald-600'
          }`}
        >
          {t.kind === 'error' ? <I.Alert size={16} /> : t.kind === 'info' ? <I.Activity size={16} /> : <I.Check size={16} />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-slate-800 leading-snug">{t.text}</p>
          {t.sub && <p className="text-[12px] text-slate-500 mt-0.5 leading-snug">{t.sub}</p>}
        </div>
        <button onClick={() => onDismiss(t.id)} className="text-slate-300 hover:text-slate-500 shrink-0">
          <I.X size={14} />
        </button>
      </div>
    ))}
  </div>
)

export const EmptyState = ({ icon, title, body, action }) => (
  <div className="py-16 text-center">
    <div className="mx-auto h-14 w-14 rounded-2xl bg-slate-50 text-slate-300 grid place-items-center mb-4">{icon}</div>
    <p className="font-medium text-slate-700">{title}</p>
    {body && <p className="text-[13px] text-slate-500 mt-1 max-w-sm mx-auto">{body}</p>}
    {action && <div className="mt-5">{action}</div>}
  </div>
)

export const SectionTitle = ({ children, action }) => (
  <div className="flex items-center justify-between mb-3.5">
    <h2 className="text-[15px] font-semibold text-slate-900">{children}</h2>
    {action}
  </div>
)

export const Field = ({ label, children, hint, required }) => (
  <div>
    <label className="label">
      {label} {required && <span className="text-rose-500">*</span>}
    </label>
    {children}
    {hint && <p className="text-[12px] text-slate-400 mt-1.5">{hint}</p>}
  </div>
)

// DICOM-style short codes keep labels legible at small sizes
export const MODALITY_CODE = { CT: 'CT', MRI: 'MRI', 'X-Ray': 'XR', Ultrasound: 'US', Mammography: 'MG', 'PET-CT': 'PET' }

export const ModalityBadge = ({ modality, size = 'md' }) => {
  const map = {
    CT: 'from-sky-500 to-sky-600',
    MRI: 'from-violet-500 to-violet-600',
    'X-Ray': 'from-slate-500 to-slate-600',
    Ultrasound: 'from-teal-500 to-teal-600',
    Mammography: 'from-pink-500 to-pink-600',
    'PET-CT': 'from-amber-500 to-amber-600',
  }
  const dim = size === 'sm' ? 'h-8 w-11 text-[10.5px]' : 'h-10 w-14 text-[12px]'
  return (
    <div
      title={modality}
      className={`${dim} shrink-0 rounded-lg bg-gradient-to-br ${map[modality] || 'from-slate-500 to-slate-600'} text-white font-bold grid place-items-center tracking-wide`}
    >
      {MODALITY_CODE[modality] || modality}
    </div>
  )
}
