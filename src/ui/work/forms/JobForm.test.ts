/**
 * The job form rendered to HTML (react-dom/server, no browser): the test ids of contracts-2a §7.5,
 * every input of a job, the request block for a requested job, the products editor, the edit
 * mode's status and acres reset, the 409 line and the loading state. Typing, saving and the
 * mocked API are covered by e2e/m2a-forms.spec.ts.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { JOB_CONFLICT_MESSAGE } from '../contract';
import { FIXTURE_IDS, makeJobOptions, makeJobView } from './fixtures';
import { jobValues, newJobValues } from './form-model';
import { type FormNotice, JobForm, JobFormView, type JobFormViewProps } from './JobForm';

const noop = () => {};

function render(over: Partial<JobFormViewProps> = {}): string {
  const props: JobFormViewProps = {
    variant: 'wall',
    mode: 'new',
    values: newJobValues({ fieldId: FIXTURE_IDS.field }, makeJobOptions()),
    options: makeJobOptions(),
    base: null,
    errors: {},
    saving: false,
    notice: null,
    loadError: null,
    onChange: noop,
    onSubmit: noop,
    onCancel: noop,
    onRetryLoad: noop,
    onDiscard: noop,
    ...over,
  };
  return renderToStaticMarkup(createElement(JobFormView, props));
}

describe('JobFormView', () => {
  test('a new job: every input, with the tapped field and its customer chosen', () => {
    const html = render();
    expect(html).toContain('data-testid="job-form" data-mode="new" data-variant="wall"');
    expect(html).toContain('data-state="ready"');
    for (const id of [
      'kind',
      'business-line',
      'status',
      'priority',
      'title',
      'field',
      'customer',
      'window-from',
      'window-to',
      'crop-year',
      'planned-acres',
      'planned-qty',
      'planned-unit',
      'notes',
      'products',
      'product-add',
      'save',
      'cancel',
    ]) {
      expect(html, id).toContain(`data-testid="job-form-${id}"`);
    }
    expect(html).toMatch(
      new RegExp(
        `<option value="${FIXTURE_IDS.field}" selected="">Abernath East 80 · Adrian · 78.4 ac`,
      ),
    );
    expect(html).toMatch(
      new RegExp(`<option value="${FIXTURE_IDS.customer}" selected="">Halvorsen`),
    );
    expect(html).toContain('Gail Pressler · Juniper Hill Farms LLC');
    expect(html).toContain('placeholder="78.4"');
    expect(html).toContain('From the boundary: 78.4 ac.');
    expect(html).toContain('<option value="" selected="">The field’s growing year</option>');
    expect(html).toContain('<option value="2027">2027</option>');
    expect(html).toContain('Atrazine 4L (restricted use)');
    expect(html).not.toContain('data-testid="job-form-request"');
    expect(html).toContain('>Add job<');
  });

  test('a requested job asks who asked and how (no "request link" choice by hand)', () => {
    const values = { ...newJobValues(), status: 'requested' as const };
    const html = render({ values });
    expect(html).toContain('data-testid="job-form-request"');
    for (const id of ['request-channel', 'requester', 'requester-name', 'requester-phone']) {
      expect(html, id).toContain(`data-testid="job-form-${id}"`);
    }
    expect(html).toContain('>Phone call<');
    expect(html).toContain('>Text message<');
    expect(html).not.toContain('>Request link<');
  });

  test('products: each with rate, unit and supplied-by; retired ones still named', () => {
    const job = makeJobView({
      products: [
        {
          id: FIXTURE_IDS.jobProduct,
          productId: '7d4c1b2a-3e4f-4a5b-8c6d-1e2f3a4b5c99',
          name: 'Old herbicide',
          kind: 'chemical',
          rate: 1.5,
          unit: 'pt_ac',
          suppliedBy: 'customer',
          restrictedUse: true,
          epaRegNo: null,
        },
      ],
    });
    const html = render({ mode: 'edit', base: job, values: jobValues(job) });
    expect(html).toContain('data-testid="job-form-product"');
    expect(html).toContain('Old herbicide');
    expect(html).toContain('>retired<');
    expect(html).toContain('>restricted use<');
    expect(html).toMatch(/data-testid="job-form-product-rate"[^>]*value="1.5"/);
    expect(html).toContain('<option value="pt_ac" selected="">pt/ac</option>');
    expect(html).toContain('<option value="customer" selected="">Customer&#x27;s product</option>');
  });

  test('an edit: the status, no status picker, Save, the acres reset for typed acres', () => {
    const job = makeJobView({ status: 'assigned', plannedAcres: 75, plannedAcresByHand: true });
    const html = render({ mode: 'edit', base: job, values: jobValues(job) });
    expect(html).toContain('data-mode="edit"');
    expect(html).toContain('data-testid="job-form-current-status" data-status="assigned"');
    expect(html).toContain('>Assigned<');
    expect(html).not.toContain('data-testid="job-form-status"');
    expect(html).toContain('data-testid="job-form-planned-acres-reset"');
    expect(html).toContain('Typed by hand');
    expect(html).toContain('>Save<');
    // A job with a crop year offers no "automatic" choice.
    expect(html).not.toContain('The field’s growing year');
  });

  test('the 409 line, an error line, and the phone variant', () => {
    const conflict: FormNotice = { kind: 'conflict', text: JOB_CONFLICT_MESSAGE };
    const html = render({ notice: conflict, variant: 'phone' });
    expect(html).toContain('data-testid="job-form-conflict"');
    expect(html).toContain(JOB_CONFLICT_MESSAGE);
    expect(html).toContain('data-testid="job-form-discard"');
    expect(html).toContain('data-variant="phone"');
    expect(render({ notice: { kind: 'error', text: 'Nope.' } })).toContain(
      'data-testid="job-form-error"',
    );
  });

  test('loading: inputs disabled until the choices arrive; a load error offers a retry', () => {
    const html = render({ options: null });
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('<fieldset class="');
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toMatch(
      /data-testid="job-form-save"[^>]*disabled=""|disabled=""[^>]*data-testid="job-form-save"/,
    );
    expect(render({ options: null, loadError: 'The server answered 503.' })).toContain(
      'data-testid="job-form-load-error"',
    );
  });
});

describe('JobForm', () => {
  test('renders the view for a new job before anything loads', () => {
    const html = renderToStaticMarkup(
      createElement(JobForm, { variant: 'phone', onSaved: noop, onCancel: noop }),
    );
    expect(html).toContain('data-testid="job-form" data-mode="new" data-variant="phone"');
  });
});
