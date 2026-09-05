import { useState } from 'react'
import Shell from '../components/Shell'
import { useStore } from '../store'
import { BODY_PARTS, MODALITIES, RADIOLOGISTS, REFERRING, suggestRadiologist } from '../data/seed'
import * as I from '../components/Icons'
import { Avatar, Field, Modal, ModalityBadge } from '../components/ui'
import { dateTime } from '../lib/format'

const nextId = (studies) => {
  const nums = studies.map((s) => parseInt(s.id.replace(/\D/g, ''), 10)).filter(Number.isFinite)
  return `STD-${Math.max(24815, ...nums) + 1}`
}

const nextPatientId = (studies) => {
  const nums = studies.map((s) => parseInt(s.patient.id.replace(/\D/g, ''), 10)).filter(Number.isFinite)
  return `PT-${Math.max(10241, ...nums) + 1}`
}

export default function NewStudy() {
  const { state, addStudy, navigate, toast, notify } = useStore()
  const [assignedTo, setAssignedTo] = useState(suggestRadiologist('CT', 'Brain').id)
  const [touchedAssignee, setTouchedAssignee] = useState(false)
  const [sent, setSent] = useState(null) // the assignment email, shown after creating
  const [form, setForm] = useState({
    name: '',
    age: '',
    gender: 'M',
    phone: '',
    email: '',
    modality: 'CT',
    bodyPart: 'Brain',
    referredBy: REFERRING[0],
    priority: 'Routine',
    notes: '',
  })
  const [errors, setErrors] = useState({})

  const set = (k) => (e) => {
    const v = e.target ? e.target.value : e
    setForm((f) => {
      const next = { ...f, [k]: v, ...(k === 'modality' ? { bodyPart: BODY_PARTS[v][0] } : {}) }
      if (!touchedAssignee && (k === 'modality' || k === 'bodyPart')) {
        setAssignedTo(suggestRadiologist(next.modality, next.bodyPart).id)
      }
      return next
    })
    setErrors((x) => ({ ...x, [k]: null }))
  }

  const doctor = RADIOLOGISTS.find((r) => r.id === assignedTo)
  const suggested = suggestRadiologist(form.modality, form.bodyPart)

  const submit = (e) => {
    e.preventDefault()
    const err = {}
    if (!form.name.trim()) err.name = 'Patient name is required'
    if (!form.age || Number(form.age) <= 0) err.age = 'Enter a valid age'
    if (!/^[\d +-]{8,}$/.test(form.phone)) err.phone = 'Mobile number is required for report delivery'
    setErrors(err)
    if (Object.keys(err).length) return

    const id = nextId(state.studies)
    const now = new Date().toISOString()
    const study = {
      id,
      patient: {
        name: form.name.trim(),
        id: nextPatientId(state.studies),
        age: Number(form.age),
        gender: form.gender,
        phone: form.phone.trim(),
        email: form.email.trim(),
      },
      modality: form.modality,
      bodyPart: form.bodyPart,
      referredBy: form.referredBy,
      priority: form.priority,
      notes: form.notes.trim(),
      assignedTo,
      status: 'draft',
      createdAt: now,
      files: [],
      sizeBytes: 0,
      images: 0,
      report: null,
      shares: [],
      timeline: [
        { id: 'ev_0', at: now, actor: 'Priya Sharma', text: `Study registered for patient ${form.name.trim()}`, kind: 'create' },
        { id: 'ev_1', at: now, actor: 'System', text: `Assigned to ${doctor.name} — email notification sent to ${doctor.email}`, kind: 'assign' },
      ],
    }

    addStudy(study)
    notify({
      title: 'Radiologist notified',
      body: `${doctor.name} was emailed about ${id} — ${form.name.trim()} (${form.modality} ${form.bodyPart}).`,
      kind: 'assign',
    })
    toast(`Study ${id} created`, 'success', `${doctor.name} has been notified by email.`)
    setSent({ study, doctor, at: now })
  }

  return (
    <Shell title="New study" subtitle="Register the patient and the study before uploading images">
      <form onSubmit={submit} className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <div className="card p-6">
            <div className="flex items-center gap-2.5 mb-5">
              <div className="h-9 w-9 rounded-xl bg-brand-50 text-brand-600 grid place-items-center">
                <I.Users size={17} />
              </div>
              <div>
                <h2 className="text-[15px] font-semibold text-slate-900">Patient details</h2>
                <p className="text-[12.5px] text-slate-500">Stored as metadata — never inside the image files.</p>
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <Field label="Full name" required>
                  <input className={`input ${errors.name ? '!border-rose-400 ring-4 ring-rose-500/10' : ''}`} value={form.name} onChange={set('name')} placeholder="e.g. Rahul Verma" />
                  {errors.name && <p className="text-[12px] text-rose-600 mt-1.5">{errors.name}</p>}
                </Field>
              </div>

              <Field label="Age" required>
                <input className={`input ${errors.age ? '!border-rose-400 ring-4 ring-rose-500/10' : ''}`} value={form.age} onChange={set('age')} placeholder="41" inputMode="numeric" />
                {errors.age && <p className="text-[12px] text-rose-600 mt-1.5">{errors.age}</p>}
              </Field>

              <Field label="Gender">
                <div className="flex gap-2">
                  {['M', 'F', 'Other'].map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => set('gender')(g)}
                      className={`h-11 flex-1 rounded-xl border text-[13px] font-medium transition ${
                        form.gender === g ? 'border-brand-500 bg-brand-50 text-brand-700 ring-4 ring-brand-500/10' : 'border-slate-200 text-slate-600 hover:border-slate-300'
                      }`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label="Mobile number" required hint="Used for the OTP-protected report link.">
                <input className={`input ${errors.phone ? '!border-rose-400 ring-4 ring-rose-500/10' : ''}`} value={form.phone} onChange={set('phone')} placeholder="+91 98200 00000" />
                {errors.phone && <p className="text-[12px] text-rose-600 mt-1.5">{errors.phone}</p>}
              </Field>

              <Field label="Email" hint="Optional — receives the same secure link.">
                <input className="input" value={form.email} onChange={set('email')} placeholder="patient@email.com" />
              </Field>
            </div>
          </div>

          <div className="card p-6">
            <div className="flex items-center gap-2.5 mb-5">
              <div className="h-9 w-9 rounded-xl bg-brand-50 text-brand-600 grid place-items-center">
                <I.Image size={17} />
              </div>
              <div>
                <h2 className="text-[15px] font-semibold text-slate-900">Study details</h2>
                <p className="text-[12.5px] text-slate-500">Determines the worklist queue and report template.</p>
              </div>
            </div>

            <Field label="Modality">
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {MODALITIES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => set('modality')(m)}
                    className={`h-16 rounded-xl border flex flex-col items-center justify-center gap-1.5 transition ${
                      form.modality === m ? 'border-brand-500 bg-brand-50/60 ring-4 ring-brand-500/10' : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <ModalityBadge modality={m} size="sm" />
                  </button>
                ))}
              </div>
            </Field>

            <div className="grid sm:grid-cols-2 gap-4 mt-4">
              <Field label="Body part / protocol">
                <select className="input" value={form.bodyPart} onChange={set('bodyPart')}>
                  {BODY_PARTS[form.modality].map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
              </Field>

              <Field label="Referred by">
                <select className="input" value={form.referredBy} onChange={set('referredBy')}>
                  {REFERRING.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </Field>

              <div className="sm:col-span-2">
                <Field label="Priority">
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { v: 'Routine', d: 'Reported within 24 hours' },
                      { v: 'Urgent', d: 'Moved to the top of the worklist' },
                    ].map((p) => (
                      <button
                        key={p.v}
                        type="button"
                        onClick={() => set('priority')(p.v)}
                        className={`text-left rounded-xl border p-3 transition ${
                          form.priority === p.v ? 'border-brand-500 bg-brand-50/60 ring-4 ring-brand-500/10' : 'border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <p className="text-[13px] font-medium text-slate-800 flex items-center gap-1.5">
                          {p.v === 'Urgent' && <I.Zap size={13} className="text-rose-500" />}
                          {p.v}
                        </p>
                        <p className="text-[11.5px] text-slate-500 mt-0.5">{p.d}</p>
                      </button>
                    ))}
                  </div>
                </Field>
              </div>

              <div className="sm:col-span-2">
                <Field label="Clinical history / notes">
                  <textarea className="input !h-auto py-3 resize-none" rows={3} value={form.notes} onChange={set('notes')} placeholder="Relevant symptoms, prior surgery, allergies…" />
                </Field>
              </div>
            </div>
          </div>

          <div className="card p-6">
            <div className="flex items-center gap-2.5 mb-5">
              <div className="h-9 w-9 rounded-xl bg-brand-50 text-brand-600 grid place-items-center">
                <I.Stethoscope size={17} />
              </div>
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold text-slate-900">Send to radiologist</h2>
                <p className="text-[12.5px] text-slate-500">
                  They are emailed as soon as the study is created, and the study lands in their worklist.
                </p>
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-2.5">
              {RADIOLOGISTS.map((r) => {
                const active = assignedTo === r.id
                const fits = r.covers.includes(form.modality)
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      setAssignedTo(r.id)
                      setTouchedAssignee(true)
                    }}
                    className={`text-left rounded-xl border p-3.5 transition ${
                      active ? 'border-brand-500 bg-brand-50/60 ring-4 ring-brand-500/10' : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <Avatar initials={r.initials} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="text-[13.5px] font-medium text-slate-800 truncate">{r.name}</p>
                          {r.id === suggested.id && !touchedAssignee && (
                            <span className="chip bg-brand-100 text-brand-700 !text-[10px] !px-1.5 !py-0">Suggested</span>
                          )}
                        </div>
                        <p className="text-[12px] text-slate-500 truncate">{r.subspecialty}</p>
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className={`chip !text-[10.5px] !px-1.5 !py-0 ${r.status === 'On duty' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                            {r.status}
                          </span>
                          {!fits && <span className="text-[10.5px] text-amber-600">Does not usually read {form.modality}</span>}
                        </div>
                      </div>
                      <div className={`h-5 w-5 rounded-full border-2 grid place-items-center shrink-0 mt-0.5 ${active ? 'bg-brand-600 border-brand-600' : 'border-slate-300'}`}>
                        {active && <I.Check size={12} className="text-white" />}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="mt-4 rounded-xl bg-slate-50 border border-slate-100 p-3.5 flex gap-2.5">
              <I.Mail size={16} className="text-slate-400 shrink-0 mt-0.5" />
              <p className="text-[12.5px] text-slate-600 leading-relaxed">
                <span className="text-slate-800 font-medium">{doctor.email}</span> receives a link to the study — no patient
                images or identifiers travel in the email itself.
              </p>
            </div>
          </div>
        </div>

        {/* Summary rail */}
        <div className="space-y-5">
          <div className="card p-5 sticky top-0">
            <h3 className="text-[15px] font-semibold text-slate-900 mb-4">Summary</h3>
            <div className="flex items-center gap-3 pb-4 mb-4 border-b border-slate-100">
              <ModalityBadge modality={form.modality} />
              <div className="min-w-0">
                <p className="text-[13.5px] font-medium text-slate-800 truncate">{form.name || 'Unnamed patient'}</p>
                <p className="text-[12.5px] text-slate-500 truncate">
                  {form.age ? `${form.age}${form.gender === 'M' ? 'M' : form.gender === 'F' ? 'F' : ''} · ` : ''}
                  {form.modality} {form.bodyPart}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 pb-4 mb-4 border-b border-slate-100">
              <Avatar initials={doctor.initials} size="sm" />
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-slate-800 truncate">{doctor.name}</p>
                <p className="text-[11.5px] text-slate-500 truncate">Will be emailed on creation</p>
              </div>
            </div>

            <dl className="space-y-2.5 text-[13px]">
              {[
                ['Referred by', form.referredBy],
                ['Priority', form.priority],
                ['Mobile', form.phone || '—'],
                ['Email', form.email || '—'],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-3">
                  <dt className="text-slate-500 w-24 shrink-0">{k}</dt>
                  <dd className="text-slate-800 font-medium truncate">{v}</dd>
                </div>
              ))}
            </dl>

            <button className="btn-primary btn-lg w-full mt-5">
              Create &amp; notify radiologist <I.ArrowRight size={17} />
            </button>
            <button type="button" onClick={() => navigate('dashboard')} className="btn-ghost btn-md w-full mt-2">
              Cancel
            </button>
          </div>

          <div className="card p-4 bg-brand-50/50 border-brand-100">
            <div className="flex gap-2.5">
              <I.Shield size={16} className="text-brand-600 shrink-0 mt-0.5" />
              <p className="text-[12.5px] text-brand-900/80 leading-relaxed">
                Creating the study issues an ID and permissions, and emails the assigned radiologist. Images are only accepted
                for this study, from this signed-in user, at this centre.
              </p>
            </div>
          </div>
        </div>
      </form>

      {/* What the assigned radiologist receives */}
      <Modal
        open={!!sent}
        onClose={() => {
          const id = sent.study.id
          setSent(null)
          navigate('upload', { id })
        }}
        width="max-w-xl"
        title="Radiologist notified"
        subtitle={sent ? `${sent.study.id} · ${sent.study.patient.name}` : ''}
        icon={<I.Mail size={19} />}
      >
        {sent && (
          <div className="p-6">
            <div className="rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 bg-slate-50/70 border-b border-slate-100 space-y-0.5">
                <p className="text-[11.5px] text-slate-500">
                  To: <span className="text-slate-700">{sent.doctor.name} &lt;{sent.doctor.email}&gt;</span>
                </p>
                <p className="text-[11.5px] text-slate-500">From: no-reply@asvanta.in</p>
                <p className="text-[13.5px] font-medium text-slate-900 pt-1">
                  {sent.study.priority === 'Urgent' ? '[URGENT] ' : ''}New study for reporting — {sent.study.modality} {sent.study.bodyPart}
                </p>
              </div>
              <div className="p-4">
                <p className="text-[13px] text-slate-700 leading-relaxed">
                  Dear {sent.doctor.name.replace('Dr. ', '')},
                  <br />
                  <br />
                  A new study has been assigned to you at {state.centre.name} and is waiting for your review and signature.
                </p>

                <dl className="mt-3.5 rounded-lg bg-slate-50 border border-slate-100 p-3 space-y-1.5">
                  {[
                    ['Study', sent.study.id],
                    ['Examination', `${sent.study.modality} — ${sent.study.bodyPart}`],
                    ['Patient', `${sent.study.patient.id} · ${sent.study.patient.age}${sent.study.patient.gender}`],
                    ['Referred by', sent.study.referredBy],
                    ['Priority', sent.study.priority],
                    ['Registered', dateTime(sent.at)],
                  ].map(([k, v]) => (
                    <div key={k} className="flex gap-3 text-[12.5px]">
                      <dt className="text-slate-500 w-24 shrink-0">{k}</dt>
                      <dd className="text-slate-800 font-medium">{v}</dd>
                    </div>
                  ))}
                </dl>

                <div className="mt-3.5 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 text-white text-[12.5px] font-medium px-3.5 py-2">
                  Open the study <I.ArrowRight size={13} />
                </div>
                <p className="text-[11.5px] text-slate-400 mt-3 leading-relaxed">
                  The link opens the study after sign-in. No patient name, images or report text is included in this email.
                </p>
              </div>
            </div>

            <div className="mt-5 rounded-xl bg-amber-50 border border-amber-100 p-3.5 flex gap-2.5">
              <I.Alert size={16} className="text-amber-600 shrink-0 mt-0.5" />
              <p className="text-[12.5px] text-amber-900/80 leading-relaxed">
                The study has no images yet. {sent.doctor.name} sees it in their worklist as soon as the upload finishes.
              </p>
            </div>

            <button
              onClick={() => {
                const id = sent.study.id
                setSent(null)
                navigate('upload', { id })
              }}
              className="btn-primary btn-lg w-full mt-5"
            >
              Continue to upload images <I.ArrowRight size={17} />
            </button>
          </div>
        )}
      </Modal>
    </Shell>
  )
}
