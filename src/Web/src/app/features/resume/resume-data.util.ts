import {
  ResumeData,
  ResumeContact,
  ResumeExperience,
  ResumeEducation,
  ResumeProject,
  ResumeCertification,
  ResumeLink,
} from '../../core/models';

/** A fresh, all-empty contact block. */
export function emptyContact(): ResumeContact {
  return { fullName: '', headline: '', email: '', phone: '', location: '', links: [] };
}

/** A fresh, all-empty ResumeData (mirrors ResumeDataDto.Empty on the backend). */
export function emptyResumeData(): ResumeData {
  return {
    contact: emptyContact(),
    summary: '',
    experience: [],
    education: [],
    skills: [],
    projects: [],
    certifications: [],
  };
}

export function emptyExperience(): ResumeExperience {
  return { company: '', title: '', location: '', startDate: '', endDate: '', current: false, bullets: [''] };
}

export function emptyEducation(): ResumeEducation {
  return { school: '', degree: '', field: '', location: '', startDate: '', endDate: '', gpa: '', details: '' };
}

export function emptyProject(): ResumeProject {
  return { name: '', description: '', link: '', bullets: [''] };
}

export function emptyCertification(): ResumeCertification {
  return { name: '', issuer: '', date: '' };
}

export function emptyLink(): ResumeLink {
  return { label: '', url: '' };
}

/**
 * Deep clone of a ResumeData (structuredClone where available, JSON fallback). Used to fork an editing copy
 * that can be reverted without mutating the loaded server state, and to snapshot for change detection.
 */
export function cloneResumeData(d: ResumeData): ResumeData {
  if (typeof structuredClone === 'function') return structuredClone(d);
  return JSON.parse(JSON.stringify(d)) as ResumeData;
}

/**
 * Defensively normalize a possibly-partial ResumeData (e.g. from an AI parse) into a complete, well-shaped
 * object so the editor's two-way bindings never hit an undefined array/field.
 */
export function normalizeResumeData(d: Partial<ResumeData> | null | undefined): ResumeData {
  const base = emptyResumeData();
  if (!d) return base;
  const c: Partial<ResumeContact> = d.contact ?? {};
  return {
    contact: {
      fullName: c.fullName ?? '',
      headline: c.headline ?? '',
      email: c.email ?? '',
      phone: c.phone ?? '',
      location: c.location ?? '',
      links: Array.isArray(c.links) ? c.links.map((l) => ({ label: l?.label ?? '', url: l?.url ?? '' })) : [],
    },
    summary: d.summary ?? '',
    experience: Array.isArray(d.experience)
      ? d.experience.map((e) => ({
          company: e?.company ?? '',
          title: e?.title ?? '',
          location: e?.location ?? '',
          startDate: e?.startDate ?? '',
          endDate: e?.endDate ?? '',
          current: !!e?.current,
          bullets: Array.isArray(e?.bullets) ? e.bullets.map((b) => b ?? '') : [],
        }))
      : [],
    education: Array.isArray(d.education)
      ? d.education.map((e) => ({
          school: e?.school ?? '',
          degree: e?.degree ?? '',
          field: e?.field ?? '',
          location: e?.location ?? '',
          startDate: e?.startDate ?? '',
          endDate: e?.endDate ?? '',
          gpa: e?.gpa ?? '',
          details: e?.details ?? '',
        }))
      : [],
    skills: Array.isArray(d.skills) ? d.skills.map((s) => s ?? '') : [],
    projects: Array.isArray(d.projects)
      ? d.projects.map((p) => ({
          name: p?.name ?? '',
          description: p?.description ?? '',
          link: p?.link ?? '',
          bullets: Array.isArray(p?.bullets) ? p.bullets.map((b) => b ?? '') : [],
        }))
      : [],
    certifications: Array.isArray(d.certifications)
      ? d.certifications.map((c2) => ({ name: c2?.name ?? '', issuer: c2?.issuer ?? '', date: c2?.date ?? '' }))
      : [],
  };
}

/** Move an item within an array (in place) by delta (−1 up / +1 down); no-op at the edges. Returns the array. */
export function moveItem<T>(arr: T[], index: number, delta: number): T[] {
  const next = index + delta;
  if (next < 0 || next >= arr.length) return arr;
  const [item] = arr.splice(index, 1);
  arr.splice(next, 0, item);
  return arr;
}
