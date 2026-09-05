export const CENTRE = {
  id: 'ctr_001',
  name: 'Asvanta Diagnostics — Andheri West',
  code: 'AND-01',
  city: 'Mumbai',
}

export const USERS = {
  staff: {
    id: 'usr_staff',
    role: 'staff',
    name: 'Priya Sharma',
    title: 'Front Desk / Technician',
    email: 'priya@asvanta.in',
    phone: '+91 98200 41122',
    initials: 'PS',
  },
  radiologist: {
    id: 'usr_rad',
    role: 'radiologist',
    name: 'Dr. Anil Mehta',
    title: 'Consultant Radiologist, MD',
    email: 'dr.mehta@asvanta.in',
    phone: '+91 98700 55221',
    initials: 'AM',
  },
  patient: {
    id: 'usr_pat',
    role: 'patient',
    name: 'Rahul Verma',
    title: 'Patient',
    email: 'rahul.verma@gmail.com',
    phone: '+91 99300 78455',
    initials: 'RV',
  },
}

export const RADIOLOGISTS = [
  {
    id: 'rad_mehta',
    name: 'Dr. Anil Mehta',
    email: 'dr.mehta@asvanta.in',
    qualification: 'MD, Radiodiagnosis',
    reg: 'MMC-48211',
    subspecialty: 'Neuroradiology & body imaging',
    covers: ['CT', 'MRI', 'PET-CT'],
    initials: 'AM',
    status: 'On duty',
  },
  {
    id: 'rad_reddy',
    name: 'Dr. Kavya Reddy',
    email: 'dr.reddy@asvanta.in',
    qualification: 'MD, DNB',
    reg: 'KMC-31904',
    subspecialty: 'Musculoskeletal & MRI',
    covers: ['MRI', 'X-Ray'],
    initials: 'KR',
    status: 'On duty',
  },
  {
    id: 'rad_qureshi',
    name: 'Dr. Farhan Qureshi',
    email: 'dr.qureshi@asvanta.in',
    qualification: 'MD, FRCR',
    reg: 'MMC-52780',
    subspecialty: 'Chest & cardiac imaging',
    covers: ['CT', 'X-Ray', 'PET-CT'],
    initials: 'FQ',
    status: 'On duty',
  },
  {
    id: 'rad_kulkarni',
    name: 'Dr. Sneha Kulkarni',
    email: 'dr.kulkarni@asvanta.in',
    qualification: 'MD, Radiodiagnosis',
    reg: 'MMC-46033',
    subspecialty: "Women's imaging & mammography",
    covers: ['Mammography', 'Ultrasound'],
    initials: 'SK',
    status: 'Off duty until 6 pm',
  },
]

/** The radiologist the centre would normally send this examination to. */
export const suggestRadiologist = (modality, bodyPart = '') => {
  const b = bodyPart.toLowerCase()
  if (modality === 'Mammography' || modality === 'Ultrasound') return RADIOLOGISTS[3]
  if (b.includes('chest') || b.includes('lung') || b.includes('thorax')) return RADIOLOGISTS[2]
  if (b.includes('spine') || b.includes('knee') || b.includes('shoulder')) return RADIOLOGISTS[1]
  return RADIOLOGISTS[0]
}

export const MODALITIES = ['CT', 'MRI', 'X-Ray', 'Ultrasound', 'Mammography', 'PET-CT']

export const BODY_PARTS = {
  CT: ['Brain', 'Chest', 'Abdomen + Pelvis', 'KUB', 'Spine'],
  MRI: ['Brain', 'Lumbar Spine', 'Knee', 'Shoulder', 'Whole Abdomen'],
  'X-Ray': ['Chest PA', 'Knee AP/LAT', 'Cervical Spine', 'Pelvis'],
  Ultrasound: ['Whole Abdomen', 'Pelvis', 'Obstetric', 'Thyroid'],
  Mammography: ['Bilateral Screening', 'Diagnostic Left', 'Diagnostic Right'],
  'PET-CT': ['Whole Body', 'Brain'],
}

export const REFERRING = [
  'Dr. S. Kulkarni (Ortho)',
  'Dr. N. Iyer (Neuro)',
  'Dr. M. Patel (Physician)',
  'Dr. R. Banerjee (Oncology)',
  'Self / Walk-in',
]

const day = 86400000
const now = Date.now()
const ago = (d, h = 0) => new Date(now - d * day - h * 3600000).toISOString()

const mkTimeline = (entries) => entries.map((e, i) => ({ id: `ev_${i}`, ...e }))

export const SEED_STUDIES = [
  {
    id: 'STD-24816',
    patient: { name: 'Deepak Chauhan', id: 'PT-10244', age: 52, gender: 'M', phone: '+91 98204 71130', email: 'deepak.chauhan@gmail.com' },
    modality: 'CT',
    bodyPart: 'Abdomen + Pelvis',
    referredBy: 'Dr. M. Patel (Physician)',
    priority: 'Routine',
    assignedTo: 'rad_mehta',
    status: 'ready', // signed by the radiologist, waiting for the centre to publish
    createdAt: ago(0, 5),
    files: [{ name: 'CT_ABDOMEN_PELVIS.dcm.zip', size: 536870912, parts: 7 }],
    sizeBytes: 536870912,
    images: 512,
    report: {
      findings:
        'Liver is normal in size and attenuation with no focal lesion. Gall bladder, pancreas and spleen appear normal. A 6 mm non-obstructing calculus is noted in the lower pole of the right kidney. Both ureters are normal in course and calibre. Urinary bladder is well distended with smooth walls. No free fluid or lymphadenopathy in the abdomen or pelvis.',
      impression: 'Small non-obstructing right renal calculus. No other significant abnormality. Adequate hydration and clinical follow-up advised.',
      signedBy: 'Dr. Anil Mehta',
      signedAt: ago(0, 0.4),
    },
    shares: [],
    timeline: mkTimeline([
      { at: ago(0, 5), actor: 'Priya Sharma', text: 'Study registered for patient PT-10244', kind: 'create' },
      { at: ago(0, 5), actor: 'System', text: 'Upload authorized — 7 presigned part URLs issued', kind: 'auth' },
      { at: ago(0, 4), actor: 'Priya Sharma', text: '512 MB uploaded directly to storage', kind: 'upload' },
      { at: ago(0, 4), actor: 'System', text: 'Object keys + metadata recorded, study queued for reporting', kind: 'db' },
      { at: ago(0, 1), actor: 'Dr. Anil Mehta', text: 'Report drafted', kind: 'report' },
      { at: ago(0, 0.4), actor: 'Dr. Anil Mehta', text: 'Report signed — released to the centre for publishing', kind: 'sign' },
    ]),
  },
  {
    id: 'STD-24815',
    patient: { name: 'Rahul Verma', id: 'PT-10241', age: 41, gender: 'M', phone: '+91 99300 78455', email: 'rahul.verma@gmail.com' },
    modality: 'MRI',
    bodyPart: 'Lumbar Spine',
    referredBy: 'Dr. S. Kulkarni (Ortho)',
    priority: 'Routine',
    assignedTo: 'rad_mehta',
    status: 'reporting',
    createdAt: ago(0, 3),
    files: [
      { name: 'MRI_LSPINE_SERIES1.dcm.zip', size: 268435456, parts: 4 },
      { name: 'MRI_LSPINE_SERIES2.dcm.zip', size: 201326592, parts: 3 },
    ],
    sizeBytes: 469762048,
    images: 428,
    report: null,
    shares: [],
    timeline: mkTimeline([
      { at: ago(0, 3), actor: 'Priya Sharma', text: 'Study registered for patient PT-10241', kind: 'create' },
      { at: ago(0, 3), actor: 'System', text: 'Upload authorized — 7 presigned part URLs issued', kind: 'auth' },
      { at: ago(0, 2), actor: 'Priya Sharma', text: '448 MB uploaded directly to storage (2 files)', kind: 'upload' },
      { at: ago(0, 2), actor: 'System', text: 'Object keys + metadata recorded, study queued for reporting', kind: 'db' },
      { at: ago(0, 1), actor: 'Dr. Anil Mehta', text: 'Study opened for reporting', kind: 'report' },
    ]),
  },
  {
    id: 'STD-24814',
    patient: { name: 'Sunita Deshmukh', id: 'PT-10237', age: 56, gender: 'F', phone: '+91 98111 20034', email: 'sunita.d@gmail.com' },
    modality: 'CT',
    bodyPart: 'Chest',
    referredBy: 'Dr. M. Patel (Physician)',
    priority: 'Urgent',
    assignedTo: 'rad_mehta',
    status: 'shared',
    createdAt: ago(0, 8),
    files: [{ name: 'CT_CHEST_HRCT.dcm.zip', size: 612368384, parts: 8 }],
    sizeBytes: 612368384,
    images: 612,
    report: {
      findings:
        'HRCT chest demonstrates bilateral peripheral ground-glass opacities predominantly in the lower lobes. No pleural effusion. Mediastinal lymph nodes are not enlarged. Trachea and major bronchi are patent.',
      impression: 'Findings suggestive of resolving viral pneumonitis. Clinical correlation and follow-up HRCT after 6 weeks advised.',
      signedBy: 'Dr. Anil Mehta',
      signedAt: ago(0, 4),
    },
    shares: [
      { channel: 'whatsapp', to: '+91 98111 20034', at: ago(0, 4), status: 'read' },
      { channel: 'sms', to: '+91 98111 20034', at: ago(0, 4), status: 'delivered' },
      { channel: 'email', to: 'sunita.d@gmail.com', at: ago(0, 4), status: 'opened' },
    ],
    timeline: mkTimeline([
      { at: ago(0, 8), actor: 'Priya Sharma', text: 'Study registered for patient PT-10237', kind: 'create' },
      { at: ago(0, 8), actor: 'System', text: 'Upload authorized — 8 presigned part URLs issued', kind: 'auth' },
      { at: ago(0, 7), actor: 'Priya Sharma', text: '584 MB uploaded directly to storage', kind: 'upload' },
      { at: ago(0, 5), actor: 'Dr. Anil Mehta', text: 'Report drafted', kind: 'report' },
      { at: ago(0, 4), actor: 'Dr. Anil Mehta', text: 'Report signed — released to the centre for publishing', kind: 'sign' },
      { at: ago(0, 4), actor: 'Priya Sharma', text: 'Report published to patient — link sent via WhatsApp, SMS and email', kind: 'share' },
    ]),
  },
  {
    id: 'STD-24810',
    patient: { name: 'Imran Sheikh', id: 'PT-10229', age: 33, gender: 'M', phone: '+91 90040 11987', email: 'imran.sheikh@outlook.com' },
    modality: 'X-Ray',
    bodyPart: 'Chest PA',
    referredBy: 'Self / Walk-in',
    priority: 'Routine',
    assignedTo: 'rad_mehta',
    status: 'shared',
    createdAt: ago(1, 2),
    files: [{ name: 'XR_CHEST_PA.dcm', size: 18874368, parts: 1 }],
    sizeBytes: 18874368,
    images: 1,
    report: {
      findings: 'Both lung fields are clear. Cardiac silhouette is normal in size and contour. Costophrenic angles are clear. Bony thorax appears normal.',
      impression: 'No significant abnormality detected.',
      signedBy: 'Dr. Anil Mehta',
      signedAt: ago(1),
    },
    shares: [{ channel: 'whatsapp', to: '+91 90040 11987', at: ago(1), status: 'delivered' }],
    timeline: mkTimeline([
      { at: ago(1, 2), actor: 'Priya Sharma', text: 'Study registered for patient PT-10229', kind: 'create' },
      { at: ago(1, 2), actor: 'Priya Sharma', text: '18 MB uploaded directly to storage', kind: 'upload' },
      { at: ago(1), actor: 'Dr. Anil Mehta', text: 'Report signed — released to the centre for publishing', kind: 'sign' },
      { at: ago(1), actor: 'Priya Sharma', text: 'Report published to patient — link sent via WhatsApp', kind: 'share' },
    ]),
  },
  {
    id: 'STD-24802',
    patient: { name: 'Kavita Rao', id: 'PT-10216', age: 47, gender: 'F', phone: '+91 98455 66201', email: 'kavita.rao@yahoo.in' },
    modality: 'Mammography',
    bodyPart: 'Bilateral Screening',
    referredBy: 'Dr. R. Banerjee (Oncology)',
    priority: 'Routine',
    assignedTo: 'rad_mehta',
    status: 'uploaded',
    createdAt: ago(2, 5),
    files: [{ name: 'MG_BILATERAL.dcm.zip', size: 314572800, parts: 4 }],
    sizeBytes: 314572800,
    images: 84,
    report: null,
    shares: [],
    timeline: mkTimeline([
      { at: ago(2, 5), actor: 'Priya Sharma', text: 'Study registered for patient PT-10216', kind: 'create' },
      { at: ago(2, 5), actor: 'System', text: 'Upload authorized — 4 presigned part URLs issued', kind: 'auth' },
      { at: ago(2, 4), actor: 'Priya Sharma', text: '300 MB uploaded directly to storage', kind: 'upload' },
      { at: ago(2, 4), actor: 'System', text: 'Object keys + metadata recorded, study queued for reporting', kind: 'db' },
    ]),
  },
  {
    id: 'STD-24788',
    patient: { name: 'Arjun Nair', id: 'PT-10198', age: 28, gender: 'M', phone: '+91 97400 33218', email: 'arjun.nair@gmail.com' },
    modality: 'CT',
    bodyPart: 'Brain',
    referredBy: 'Dr. N. Iyer (Neuro)',
    priority: 'Urgent',
    assignedTo: 'rad_mehta',
    status: 'shared',
    createdAt: ago(4, 6),
    files: [{ name: 'CT_BRAIN_PLAIN.dcm.zip', size: 419430400, parts: 6 }],
    sizeBytes: 419430400,
    images: 320,
    report: {
      findings: 'No evidence of acute intracranial haemorrhage, infarct or mass effect. Ventricles and sulci are normal for age. No midline shift. Visualised paranasal sinuses are clear.',
      impression: 'Normal plain CT study of the brain.',
      signedBy: 'Dr. Anil Mehta',
      signedAt: ago(4, 3),
    },
    shares: [
      { channel: 'whatsapp', to: '+91 97400 33218', at: ago(4, 3), status: 'read' },
      { channel: 'email', to: 'arjun.nair@gmail.com', at: ago(4, 3), status: 'delivered' },
    ],
    timeline: mkTimeline([
      { at: ago(4, 6), actor: 'Priya Sharma', text: 'Study registered for patient PT-10198', kind: 'create' },
      { at: ago(4, 5), actor: 'Priya Sharma', text: '400 MB uploaded directly to storage', kind: 'upload' },
      { at: ago(4, 3), actor: 'Dr. Anil Mehta', text: 'Report signed — released to the centre for publishing', kind: 'sign' },
      { at: ago(4, 3), actor: 'Priya Sharma', text: 'Report published to patient — link sent via WhatsApp and email', kind: 'share' },
    ]),
  },
  {
    id: 'STD-24771',
    patient: { name: 'Meera Joshi', id: 'PT-10180', age: 62, gender: 'F', phone: '+91 99870 45512', email: 'meera.joshi@gmail.com' },
    modality: 'Ultrasound',
    bodyPart: 'Whole Abdomen',
    referredBy: 'Dr. M. Patel (Physician)',
    priority: 'Routine',
    assignedTo: 'rad_mehta',
    status: 'shared',
    createdAt: ago(6, 2),
    files: [{ name: 'US_ABDOMEN.dcm.zip', size: 94371840, parts: 2 }],
    sizeBytes: 94371840,
    images: 46,
    report: {
      findings: 'Liver is normal in size with mildly increased echotexture. Gall bladder is distended, wall thickness normal, no calculi. Both kidneys are normal in size and cortical echogenicity. No free fluid.',
      impression: 'Grade I fatty liver. No other significant abnormality.',
      signedBy: 'Dr. Anil Mehta',
      signedAt: ago(6),
    },
    shares: [{ channel: 'sms', to: '+91 99870 45512', at: ago(6), status: 'delivered' }],
    timeline: mkTimeline([
      { at: ago(6, 2), actor: 'Priya Sharma', text: 'Study registered for patient PT-10180', kind: 'create' },
      { at: ago(6, 1), actor: 'Priya Sharma', text: '90 MB uploaded directly to storage', kind: 'upload' },
      { at: ago(6), actor: 'Dr. Anil Mehta', text: 'Report signed — released to the centre for publishing', kind: 'sign' },
    ]),
  },
]

export const REPORT_TEMPLATES = [
  {
    id: 'tpl_normal_ct_brain',
    label: 'CT Brain — Normal',
    modality: 'CT',
    findings:
      'No evidence of acute intracranial haemorrhage, infarct or space-occupying lesion. Grey-white differentiation is preserved. Ventricular system is normal in size and configuration. No midline shift. Posterior fossa structures appear normal. Visualised paranasal sinuses and mastoid air cells are clear.',
    impression: 'Normal plain CT study of the brain.',
  },
  {
    id: 'tpl_mri_ls',
    label: 'MRI Lumbar Spine — Degenerative',
    modality: 'MRI',
    findings:
      'Straightening of the normal lumbar lordosis. Diffuse disc desiccation noted from L3-L4 to L5-S1. Posterocentral disc protrusion at L4-L5 indenting the thecal sac and causing mild bilateral lateral recess narrowing. Conus medullaris terminates at L1 level and appears normal. No marrow signal abnormality.',
    impression:
      'Degenerative disc disease of the lumbar spine with L4-L5 posterocentral disc protrusion causing mild thecal sac indentation. Clinical correlation advised.',
  },
  {
    id: 'tpl_xr_chest',
    label: 'X-Ray Chest PA — Normal',
    modality: 'X-Ray',
    findings: 'Both lung fields are clear. Cardiac silhouette is normal in size and contour. Costophrenic angles are clear. Bony thorax and soft tissues appear unremarkable.',
    impression: 'No significant abnormality detected.',
  },
  {
    id: 'tpl_mg_screening',
    label: 'Mammography — Normal screening',
    modality: 'Mammography',
    findings:
      'Bilateral craniocaudal and mediolateral oblique views were obtained. Breast parenchyma is of scattered fibroglandular density (ACR category B) bilaterally. No suspicious mass, architectural distortion or clustered microcalcification is identified in either breast. Both axillae appear unremarkable.',
    impression: 'Normal bilateral screening mammogram. BI-RADS category 1. Routine screening in 12 months advised.',
  },
  {
    id: 'tpl_pet_wholebody',
    label: 'PET-CT Whole Body — No active disease',
    modality: 'PET-CT',
    findings:
      'Whole body FDG PET-CT was performed 60 minutes after intravenous injection of F-18 FDG. No abnormal focal FDG uptake is seen in the head and neck, thorax, abdomen or pelvis. No FDG-avid lymphadenopathy. Skeletal survey shows no focal marrow uptake.',
    impression: 'No evidence of FDG-avid active disease. Follow-up as clinically indicated.',
  },
  {
    id: 'tpl_us_abdomen',
    label: 'USG Abdomen — Fatty Liver',
    modality: 'Ultrasound',
    findings:
      'Liver is normal in size measuring 14.2 cm with mildly increased parenchymal echotexture. Intrahepatic biliary radicles are not dilated. Gall bladder is well distended with normal wall thickness and no calculi. Pancreas, spleen and both kidneys appear normal. No free fluid in the abdomen.',
    impression: 'Grade I fatty liver. No other significant abnormality detected.',
  },
]

export const NOTIFICATIONS = [
  { id: 'n0', title: 'Report signed — ready to publish', body: 'Dr. Mehta signed STD-24816 — Deepak Chauhan (CT Abdomen + Pelvis). Publish it to the patient.', at: ago(0, 0.4), unread: true, kind: 'sign' },
  { id: 'n1', title: 'Report signed — ready to publish', body: 'Dr. Mehta signed STD-24814 — Sunita Deshmukh (CT Chest). Publish it to the patient.', at: ago(0, 4), unread: true, kind: 'sign' },
  { id: 'n2', title: 'Report published', body: 'STD-24814 sent to the patient — WhatsApp message has been read.', at: ago(0, 4), unread: true, kind: 'share' },
  { id: 'n3', title: 'Upload complete', body: '448 MB in 2 files stored for STD-24815 — Rahul Verma.', at: ago(0, 2), unread: false, kind: 'upload' },
  { id: 'n4', title: 'Retention notice', body: '3 studies from last year expire in under 30 days.', at: ago(1), unread: false, kind: 'clock' },
]
