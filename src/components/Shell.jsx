import { useState } from 'react'
import { useStore } from '../store'
import { USERS } from '../data/seed'
import * as I from './Icons'
import { Avatar } from './ui'
import { timeAgo } from '../lib/format'

const NAV = {
  staff: [
    { name: 'dashboard', label: 'Dashboard', icon: I.Grid },
    { name: 'studies', label: 'Studies', icon: I.Layers },
    { name: 'scanners', label: 'Scanners', icon: I.Activity },
    { name: 'new-study', label: 'Manual Upload', icon: I.Upload, demoOnly: true },
    { name: 'deliveries', label: 'Deliveries', icon: I.Send },
  ],
  radiologist: [
    { name: 'worklist', label: 'Worklist', icon: I.Stethoscope },
    { name: 'studies', label: 'All Studies', icon: I.Layers },
  ],
  patient: [{ name: 'portal', label: 'My Report', icon: I.FileText }],
}

const ROLES = [
  { key: 'staff', label: 'Centre Staff', icon: I.Building },
  { key: 'radiologist', label: 'Radiologist', icon: I.Stethoscope },
  { key: 'patient', label: 'Patient', icon: I.Users },
]

export function DemoBar() {
  const { state, switchRole, reset, toast } = useStore()
  return (
    <div className="h-11 shrink-0 bg-slate-900 text-white flex items-center gap-4 px-4 sm:px-6 text-[12.5px]">
      <div className="flex items-center gap-2 shrink-0">
        <span className="chip bg-brand-500/20 text-brand-200 !text-[10.5px] uppercase tracking-wider font-semibold">Demo</span>
        <span className="hidden sm:inline text-slate-400">View the platform as:</span>
      </div>

      <div className="flex items-center gap-1 rounded-lg bg-white/5 p-0.5">
        {ROLES.map((r) => {
          const active = state.role === r.key
          return (
            <button
              key={r.key}
              onClick={() => switchRole(r.key)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 h-7 font-medium transition ${
                active ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-300 hover:text-white hover:bg-white/10'
              }`}
            >
              <r.icon size={13} />
              <span className="hidden sm:inline">{r.label}</span>
            </button>
          )
        })}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <span className="hidden md:flex items-center gap-1.5 text-slate-400">
          <I.Shield size={13} className="text-emerald-400" />
          Frontend prototype — no live data
        </span>
        <button
          onClick={() => {
            reset()
            toast('Demo reset', 'info', 'All studies and reports restored to their starting state.')
          }}
          className="flex items-center gap-1.5 text-slate-300 hover:text-white transition"
        >
          <I.Refresh size={13} /> Reset
        </button>
      </div>
    </div>
  )
}

function Sidebar() {
  const { state, navigate, logout } = useStore()
  const items = (NAV[state.role] || []).filter((it) => !(state.live && it.demoOnly))
  const user = state.liveUser || USERS[state.role]

  return (
    <aside className="w-[240px] shrink-0 bg-white border-r border-slate-200 flex-col hidden lg:flex">
      <div className="h-16 flex items-center gap-2.5 px-5 border-b border-slate-100">
        <I.Logo size={30} />
        <div className="leading-tight">
          <p className="font-semibold text-slate-900 tracking-tight">Asvanta</p>
          <p className="text-[10.5px] text-slate-400 uppercase tracking-wider">Diagnostics</p>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-0.5">
        <p className="px-3 pt-2 pb-2 text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">Menu</p>
        {items.map((it) => {
          const active = state.route.name === it.name
          return (
            <button
              key={it.name}
              onClick={() => navigate(it.name)}
              className={`w-full flex items-center gap-3 rounded-xl px-3 h-10 text-[13.5px] font-medium transition ${
                active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <it.icon size={17} className={active ? 'text-brand-600' : 'text-slate-400'} />
              {it.label}
              {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-brand-600" />}
            </button>
          )
        })}
      </nav>

      <div className="p-3 border-t border-slate-100">
        <div className="rounded-xl bg-slate-50 p-3 mb-2">
          <div className="flex items-center gap-2.5">
            <Avatar initials={user.initials} size="sm" />
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-slate-800 truncate">{user.name}</p>
              <p className="text-[11px] text-slate-500 truncate">{user.title}</p>
            </div>
          </div>
        </div>
        <button onClick={logout} className="btn-ghost btn-sm w-full justify-start">
          <I.LogOut size={15} /> Sign out
        </button>
      </div>
    </aside>
  )
}

function TopBar({ title, subtitle, actions }) {
  const { state, readNotifications, navigate } = useStore()
  const [open, setOpen] = useState(false)
  const unread = state.notifications.filter((n) => n.unread).length

  return (
    <header className="h-16 shrink-0 bg-white/85 backdrop-blur border-b border-slate-200 flex items-center gap-2 sm:gap-4 px-4 sm:px-7 relative z-20">
      <div className="min-w-0 flex-1">
        <h1 className="text-[15px] sm:text-[17px] font-semibold text-slate-900 tracking-tight truncate">{title}</h1>
        {subtitle && <p className="text-[12.5px] text-slate-500 truncate">{subtitle}</p>}
      </div>

      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {actions}
        <div className="hidden md:flex items-center gap-2 rounded-xl border border-slate-200 px-3 h-10 text-[13px] text-slate-500">
          <I.Building size={15} className="text-slate-400" />
          {state.centre.code}
        </div>
        <div className="relative">
          <button
            onClick={() => {
              setOpen((o) => !o)
              if (!open) readNotifications()
            }}
            className="btn-ghost h-10 w-10 rounded-xl relative"
          >
            <I.Bell size={18} />
            {unread > 0 && (
              <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-white" />
            )}
          </button>
          {open && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
              <div className="absolute right-0 mt-2 w-[min(340px,calc(100vw-2rem))] card z-20 animate-scale-in overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                  <p className="font-semibold text-[14px] text-slate-900">Notifications</p>
                  <span className="text-[11.5px] text-slate-400">{state.notifications.length} total</span>
                </div>
                <div className="max-h-[360px] overflow-y-auto divide-y divide-slate-50">
                  {state.notifications.map((n) => (
                    <div key={n.id} className="px-4 py-3 hover:bg-slate-50/70 transition">
                      <div className="flex items-start gap-2.5">
                        <span className={`mt-1 h-1.5 w-1.5 rounded-full shrink-0 ${n.unread ? 'bg-brand-500' : 'bg-slate-200'}`} />
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium text-slate-800">{n.title}</p>
                          <p className="text-[12px] text-slate-500 leading-snug mt-0.5">{n.body}</p>
                          <p className="text-[11px] text-slate-400 mt-1">{timeAgo(n.at)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => { setOpen(false); navigate('deliveries') }}
                  className="w-full text-[12.5px] text-brand-700 font-medium py-2.5 hover:bg-brand-50 transition border-t border-slate-100"
                >
                  View delivery log
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}

function BottomNav() {
  const { state, navigate } = useStore()
  const items = (NAV[state.role] || []).filter((it) => !(state.live && it.demoOnly))
  return (
    <nav className="lg:hidden shrink-0 bg-white border-t border-slate-200 flex items-stretch pb-[env(safe-area-inset-bottom)]">
      {items.map((it) => {
        const active = state.route.name === it.name
        return (
          <button
            key={it.name}
            onClick={() => navigate(it.name)}
            className={`flex-1 flex flex-col items-center justify-center gap-1 py-2.5 transition ${
              active ? 'text-brand-700' : 'text-slate-400'
            }`}
          >
            <it.icon size={19} />
            <span className="text-[10px] font-medium leading-none text-center px-0.5">{it.label.split(' ')[0]}</span>
          </button>
        )
      })}
    </nav>
  )
}

/** Live mode: who is signed in and which PACS the app is reading from, instead of the demo switcher. */
function LiveBar() {
  const { user } = useStore()
  return (
    <div className="h-9 shrink-0 bg-slate-900 text-white flex items-center gap-3 px-4 sm:px-6 text-[12px]">
      <span className="flex items-center gap-1.5 text-emerald-300">
        <span className="h-2 w-2 rounded-full bg-emerald-400" /> Connected to PACS
      </span>
      <span className="text-slate-400 hidden sm:inline">Scans arrive from the scanners automatically</span>
      <span className="ml-auto text-slate-300">{user?.name} · {user?.role === 'radiologist' ? 'Radiologist' : 'Centre staff'}</span>
    </div>
  )
}

export default function Shell({ title, subtitle, actions, children, wide }) {
  const { live } = useStore()
  return (
    <div className="h-screen flex flex-col bg-slate-50">
      {live ? <LiveBar /> : <DemoBar />}
      <div className="flex-1 flex min-h-0">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <TopBar title={title} subtitle={subtitle} actions={actions} />
          <main className="flex-1 overflow-y-auto">
            <div className={`${wide ? 'max-w-[1400px]' : 'max-w-[1180px]'} mx-auto px-4 sm:px-7 py-5 sm:py-7`}>{children}</div>
          </main>
          <BottomNav />
        </div>
      </div>
    </div>
  )
}
