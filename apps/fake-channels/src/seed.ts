import type { EntityStore } from './store';
import { mkLocation, mkParams } from './routes/dealroom';

/**
 * Seeds the fake-channels store with default configuration data
 * so the apps/web pipeline configuration UI has something to work with.
 * Idempotent — skips if data already exists for a given service.
 */
export function seedDefaults(store: EntityStore) {
  // ── Affinity ──────────────────────────────────────────────
  if (store.list('affinity', 'field').length === 0) {
    // Built-in properties (name, domain, first_name, last_name, email) are now
    // handled via adapterConfig, not field mappings — only custom fields here.
    const fields = [
      { id: 3, name: 'Description', entity_type: 1, value_type: 6, list_id: null, enrichment_source: 'none', allows_multiple: false, track_changes: false, dropdown_options: null },
      { id: 4, name: 'Industry', entity_type: 1, value_type: 6, list_id: null, enrichment_source: 'none', allows_multiple: false, track_changes: false, dropdown_options: null },
      { id: 5, name: 'Location', entity_type: 1, value_type: 5, list_id: null, enrichment_source: 'none', allows_multiple: false, track_changes: false, dropdown_options: null },
      { id: 6, name: 'Stage', entity_type: 1, value_type: 2, list_id: null, enrichment_source: 'none', allows_multiple: false, track_changes: false, dropdown_options: [
        { id: 1, text: 'Pre-Seed', rank: 0, color: 0 },
        { id: 2, text: 'Seed', rank: 1, color: 1 },
        { id: 3, text: 'Series A', rank: 2, color: 2 },
        { id: 4, text: 'Series B', rank: 3, color: 3 },
      ]},
      { id: 7, name: 'Status', entity_type: 1, value_type: 7, list_id: null, enrichment_source: 'none', allows_multiple: false, track_changes: true, dropdown_options: [
        { id: 10, text: 'New', rank: 0, color: 0 },
        { id: 11, text: 'In Review', rank: 1, color: 1 },
        { id: 12, text: 'Passed', rank: 2, color: 2 },
        { id: 13, text: 'Active', rank: 3, color: 3 },
      ]},
      { id: 11, name: 'Amount Raised', entity_type: 1, value_type: 3, list_id: null, enrichment_source: 'none', allows_multiple: false, track_changes: false, dropdown_options: null },
      { id: 12, name: 'Founded Date', entity_type: 1, value_type: 4, list_id: null, enrichment_source: 'none', allows_multiple: false, track_changes: false, dropdown_options: null },
    ];
    for (const f of fields) {
      store.create('affinity', 'field', f, String(f.id));
    }

    // Default list — an ORGANIZATION list (type 1): every entry on it is an org
    // (entity_type 1, below) and its list-scoped custom fields are org fields, so
    // the list type must agree (Affinity lists are typed; the entry/field entity
    // kinds follow the list). Was mistakenly `type: 0` (person), which only
    // stayed hidden while the adapter queried org∪person fields blindly.
    store.create('affinity', 'list', { name: 'Pipeline', type: 1, creator_id: 1 }, '1');
    console.log('  Seeded affinity: 7 fields, 1 list');
  }

  // An ENRICHMENT-SOURCED field. Affinity populates it, and the field-value API
  // still accepts a write to it (confirmed live 2026-10-07), so it is writable
  // like the hand-maintained fields beside it. Own idempotency gate — additive,
  // so an already-seeded store gains it.
  if (!store.get('affinity', 'field', '13')) {
    store.create('affinity', 'field', { id: 13, name: 'Employee Count', entity_type: 1, value_type: 3, list_id: null, enrichment_source: 'affinity-data', allows_multiple: false, track_changes: false, dropdown_options: null }, '13');
    console.log('  Seeded affinity: enrichment-sourced field 13 (Employee Count)');
  }

  // List-scoped custom fields for the Pipeline list (list_id 1). Affinity
  // field values are per-list, so the pinned `List Entry — Pipeline` type
  // describes exactly these — without them it honestly (but uselessly) shows
  // zero fields. Gated separately from the block above so stores seeded
  // before this fixture existed gain them on boot.
  if (!store.list('affinity', 'field').some((f) => f.data.list_id === 1)) {
    const pipelineListFields = [
      { id: 21, name: 'Deal Stage', entity_type: 1, value_type: 7, list_id: 1, enrichment_source: 'none', allows_multiple: false, track_changes: true, dropdown_options: [
        { id: 30, text: 'Sourced', rank: 0, color: 0 },
        { id: 31, text: 'Screening', rank: 1, color: 1 },
        { id: 32, text: 'Partner Review', rank: 2, color: 2 },
        { id: 33, text: 'Term Sheet', rank: 3, color: 3 },
      ]},
      { id: 22, name: 'Deal Size', entity_type: 1, value_type: 3, list_id: 1, enrichment_source: 'none', allows_multiple: false, track_changes: false, dropdown_options: null },
      { id: 23, name: 'Next Step', entity_type: 1, value_type: 6, list_id: 1, enrichment_source: 'none', allows_multiple: false, track_changes: false, dropdown_options: null },
    ];
    for (const f of pipelineListFields) {
      store.create('affinity', 'field', f, String(f.id));
    }
    console.log('  Seeded affinity: 3 list-scoped fields for list 1 (Pipeline)');
  }

  // A list-scoped PERSON-valued field on Pipeline (list 1): a reference field
  // on an ENTRY, which is an edge off the entry rather than a value on it. Its
  // value hangs off the entry while still being addressed against the
  // organization, so nothing else in the fixture exercises that pairing.
  if (!store.get('affinity', 'field', '24')) {
    store.create('affinity', 'field', { id: 24, name: 'Owners', entity_type: 1, value_type: 0, list_id: 1, enrichment_source: 'none', allows_multiple: true, track_changes: false, dropdown_options: null }, '24');
    console.log('  Seeded affinity: list-scoped reference field 24 (Owners) on list 1');
  }

  // A SECOND organization list, with its OWN list-scoped fields. Affinity lists
  // are genuinely per-list typed, so `Organization -[:List Entries]->` is a
  // polymorphic edge — and a union of ONE member can't tell the intersection
  // apart from that member's surface, which is exactly what a hardcode would
  // pass. `Portfolio`'s fields deliberately share NO name with `Pipeline`'s, so
  // narrowing to one list and getting the other's fields is a visible failure.
  if (!store.get('affinity', 'list', '3')) {
    store.create('affinity', 'list', { name: 'Portfolio', type: 1, creator_id: 1 }, '3');
    const portfolioListFields = [
      { id: 41, name: 'Ownership %', entity_type: 1, value_type: 3, list_id: 3, enrichment_source: 'none', allows_multiple: false, track_changes: false, dropdown_options: null },
      { id: 42, name: 'Board Seat', entity_type: 1, value_type: 6, list_id: 3, enrichment_source: 'none', allows_multiple: false, track_changes: false, dropdown_options: null },
      { id: 43, name: 'Investment Date', entity_type: 1, value_type: 4, list_id: 3, enrichment_source: 'none', allows_multiple: false, track_changes: false, dropdown_options: null },
    ];
    for (const f of portfolioListFields) {
      store.create('affinity', 'field', f, String(f.id));
    }
    console.log('  Seeded affinity: list 3 (Portfolio, org) + 3 list-scoped fields');
  }

  // A PERSON list (type 0). Without one, `Person`'s membership enum is empty in
  // the fake and the person side of the list surface can't be exercised at all
  // (noted as a gap when the membership write shipped).
  if (!store.get('affinity', 'list', '4')) {
    store.create('affinity', 'list', { name: 'Advisors', type: 0, creator_id: 1 }, '4');
    const advisorListFields = [
      { id: 51, name: 'Advisory Focus', entity_type: 0, value_type: 6, list_id: 4, enrichment_source: 'none', allows_multiple: false, track_changes: false, dropdown_options: null },
      { id: 52, name: 'Engagement', entity_type: 0, value_type: 7, list_id: 4, enrichment_source: 'none', allows_multiple: false, track_changes: true, dropdown_options: [
        { id: 60, text: 'Prospective', rank: 0, color: 0 },
        { id: 61, text: 'Active', rank: 1, color: 1 },
        { id: 62, text: 'Lapsed', rank: 2, color: 2 },
      ]},
    ];
    for (const f of advisorListFields) {
      store.create('affinity', 'field', f, String(f.id));
    }
    console.log('  Seeded affinity: list 4 (Advisors, person) + 2 list-scoped fields');
  }

  // Read-surface fixtures for the 2026-07-17 type-graph redesign (the
  // explorer review): an org + person + opportunity cluster carrying notes
  // (incl. a reply), files, reminders, interactions, and relationship
  // strengths, so every new edge has something to enumerate. Own idempotency
  // gate (additive — existing stores gain these on boot; ids in the 96xx–99xx
  // range so they can't collide with runtime-created records).
  if (!store.get('affinity', 'organization', '9601')) {
    const now = '2026-07-10T10:00:00.000Z';
    const grace = {
      id: 9701,
      type: 0,
      first_name: 'Grace',
      last_name: 'Graph',
      primary_email: 'grace@graphredesign.co',
      emails: ['grace@graphredesign.co'],
    };
    const jonas = {
      id: 9702,
      type: 1,
      first_name: 'Jonas',
      last_name: 'Internal',
      primary_email: 'jonas@example.com',
      emails: ['jonas@example.com'],
    };

    store.create('affinity', 'organization', {
      name: 'Graph Redesign Co',
      domain: 'graphredesign.co',
      domains: ['graphredesign.co'],
      person_ids: [9701],
      global: false,
    }, '9601');
    store.create('affinity', 'person', {
      first_name: 'Grace',
      last_name: 'Graph',
      primary_email: 'grace@graphredesign.co',
      emails: ['grace@graphredesign.co'],
      organization_ids: [9601],
    }, '9701');
    store.create('affinity', 'person', {
      first_name: 'Jonas',
      last_name: 'Internal',
      primary_email: 'jonas@example.com',
      emails: ['jonas@example.com'],
      organization_ids: [],
    }, '9702');
    store.create('affinity', `list_entry:1`, {
      list_id: 1,
      entity_id: 9601,
      entity_type: 1,
      created_at: now,
    }, '9801');

    // An opportunity list + one opportunity on it (list type 8 = opportunity).
    store.create('affinity', 'list', { name: 'Deals', type: 8, creator_id: 1 }, '2');
    store.create('affinity', 'opportunity', {
      name: 'Graph Redesign — Series A',
      person_ids: [9701],
      organization_ids: [9601],
      list_entries: [
        { id: 9802, list_id: 2, entity_id: 9901, entity_type: 8, created_at: now },
      ],
    }, '9901');
    store.create('affinity', `list_entry:2`, {
      list_id: 2,
      entity_id: 9901,
      entity_type: 8,
      created_at: now,
    }, '9802');

    // Notes: a parent on the org (+person), a threaded reply (no entity
    // associations — real-API reply semantics), and one on the opportunity.
    store.create('affinity', 'note', {
      content: 'Kickoff call notes — strong founding team.',
      organization_ids: [9601],
      person_ids: [9701],
      opportunity_ids: [],
      parent_id: null,
      type: 0,
      creator_id: 9702,
      created_at: now,
      updated_at: null,
    }, '9950');
    store.create('affinity', 'note', {
      content: 'Reply: circulated the memo to the partnership.',
      organization_ids: [],
      person_ids: [],
      opportunity_ids: [],
      parent_id: 9950,
      type: 0,
      creator_id: 9702,
      created_at: '2026-07-11T10:00:00.000Z',
      updated_at: null,
    }, '9951');
    store.create('affinity', 'note', {
      content: 'Series A framing: raise at 40M pre.',
      organization_ids: [],
      person_ids: [],
      opportunity_ids: [9901],
      parent_id: null,
      type: 0,
      creator_id: 9702,
      created_at: now,
      updated_at: null,
    }, '9952');

    // Files: one on the org, one on the person.
    store.create('affinity', 'file', {
      name: 'graph-deck.pdf',
      size: 2048,
      person_id: null,
      organization_id: 9601,
      opportunity_id: null,
      uploader_id: 9702,
      created_at: now,
    }, '9960');
    store.create('affinity', 'file', {
      name: 'grace-intro.txt',
      size: 64,
      person_id: 9701,
      organization_id: null,
      opportunity_id: null,
      uploader_id: 9702,
      created_at: now,
    }, '9961');

    // A recurring overdue reminder tagged with Grace, owned by Jonas.
    store.create('affinity', 'reminder', {
      type: 1,
      reset_type: 1,
      status: 2,
      content: 'Follow up with Grace on the data room',
      due_date: '2026-07-15T09:00:00.000Z',
      created_at: now,
      completed_at: null,
      reminder_days: 30,
      creator: jonas,
      owner: jonas,
      completer: null,
      person: grace,
      organization: null,
      opportunity: null,
    }, '9970');

    // Interactions: one received email + one meeting (with a note attached).
    // The *_ids arrays are the fake's filter index (stripped from responses).
    store.create('affinity', 'interaction', {
      type: 3,
      date: '2026-07-08T09:30:00.000Z',
      subject: 'Intro: Graph Redesign Co',
      direction: 1,
      from: grace,
      to: [jonas],
      cc: [],
      organization_ids: [9601],
      person_ids: [9701],
      opportunity_ids: [9901],
    }, '9980');
    store.create('affinity', 'interaction', {
      type: 0,
      date: '2026-07-10T14:00:00.000Z',
      title: 'Partner meeting — Graph Redesign',
      attendees: ['grace@graphredesign.co', 'jonas@example.com'],
      start_time: '2026-07-10T14:00:00.000Z',
      end_time: '2026-07-10T14:45:00.000Z',
      manual_creator_id: 9702,
      notes: [9950],
      persons: [grace, jonas],
      organization_ids: [9601],
      person_ids: [9701],
      opportunity_ids: [],
    }, '9981');

    // Relationship strength between Grace (external) and Jonas (internal).
    store.create('affinity', 'relationship_strength', {
      external_id: 9701,
      internal_id: 9702,
      strength: 0.62,
    }, '9701:9702');

    console.log('  Seeded affinity read surfaces: org 9601 cluster (opportunity, notes+reply, files, reminder, interactions, relationship strength)');
  }

  // ── Attio ─────────────────────────────────────────────────
  function attioAttr(objectId: string, a: {
    api_slug: string;
    title: string;
    type: string;
    is_required: boolean;
    is_unique: boolean;
    /** Attio's multi-valued attributes (a company's `team` holds many
     *  people). Defaults false — most attributes are single-valued — but it
     *  must be expressible, because a multi-valued field is the only thing
     *  the language's append markers (`+:` / `+?:`) are legal on. */
    is_multiselect?: boolean;
    /** For `record-reference` attributes, the target object the
     *  reference points to (e.g. people.parent_object → companies).
     *  Optional `target_attribute_id` defaults to 'name' — Attio's
     *  relationship metadata names the target's identifying attribute
     *  but our adapters only read `object_id` so the exact slug
     *  doesn't matter beyond being present. */
    relationship?: { target_object_id: string; target_attribute_id?: string };
    /** The OTHER way Attio names a record-reference's target, and the only one
     *  a reference created through the Attio UI has: `relationship` is null and
     *  the allowed targets sit in `config.record_reference.allowed_object_ids`.
     *  Seeded so the dev loop carries a UI-shaped reference, not only Attio's
     *  built-in paired ones — reading `relationship` alone made every
     *  UI-created reference vanish from the schema. `null` = unrestricted. */
    allowed_object_ids?: string[] | null;
  }) {
    return {
      id: {
        workspace_id: 'test',
        object_id: objectId,
        attribute_id: a.api_slug,
      },
      api_slug: a.api_slug,
      title: a.title,
      description: null,
      type: a.type,
      is_multiselect: a.is_multiselect ?? false,
      is_unique: a.is_unique,
      is_required: a.is_required,
      is_writable: true,
      is_system_attribute: false,
      relationship: a.relationship
        ? {
            id: {
              workspace_id: 'test',
              object_id: a.relationship.target_object_id,
              attribute_id: a.relationship.target_attribute_id ?? 'name',
            },
          }
        : null,
      // `config` is required by the real Attio API attributeValidator
      // (apiClient.ts) — an empty object is the safe default.
      config:
        a.allowed_object_ids !== undefined
          ? { record_reference: { allowed_object_ids: a.allowed_object_ids } }
          : {},
    };
  }

  if (store.list('attio', 'object').length === 0) {
    // The real Attio objectValidator (apiClient.ts) requires id.{workspace_id, object_id};
    // include the id so listObjects() parses cleanly when test-harness creds are
    // injected with our base URL. object_id matches the api_slug for simplicity.
    const objects = [
      {
        id: { workspace_id: 'test', object_id: 'companies' },
        api_slug: 'companies',
        singular_noun: 'Company',
        plural_noun: 'Companies',
      },
      {
        id: { workspace_id: 'test', object_id: 'people' },
        api_slug: 'people',
        singular_noun: 'Person',
        plural_noun: 'People',
      },
      {
        id: { workspace_id: 'test', object_id: 'deals' },
        api_slug: 'deals',
        singular_noun: 'Deal',
        plural_noun: 'Deals',
      },
    ];
    for (const o of objects) {
      store.create('attio', 'object', o);
    }

    // Attributes for companies — shape must match the real Attio API
    // attributeValidator (apiClient.ts). Missing fields (id, description,
    // is_multiselect, is_writable, is_system_attribute) make the api
    // adapter's Zod parse fail; BackOff treats validation errors as
    // transient and retries up to 156s — hanging any describeTypes call
    // that walks into a record type.
    // `is_unique` mirrors production Attio defaults: company `domains`
    // and person `email_addresses` are unique-by-attribute, everything
    // else is non-unique. These flow through the translation-graph
    // adapter's `listUniquenessConstraints` to drive entity resolution.
    const companyAttrs = [
      { api_slug: 'name', title: 'Name', type: 'text', is_required: true, is_unique: false },
      { api_slug: 'domains', title: 'Domains', type: 'domain', is_required: false, is_unique: true },
      { api_slug: 'description', title: 'Description', type: 'text', is_required: false, is_unique: false },
      // Multi-select in real Attio (the REST docs pass `["3D Printing",
      // "Architecture"]`), and the ONLY multi-valued FIELD in the fake — which
      // makes it the one thing the language's `+:` / `+?:` append markers can
      // be demonstrated against truthfully. A multi-valued EDGE (`team`) does
      // not serve: append markers are a field construct.
      { api_slug: 'categories', title: 'Categories', type: 'select', is_required: false, is_unique: false, is_multiselect: true },
      { api_slug: 'team_size', title: 'Team Size', type: 'number', is_required: false, is_unique: false },
      // Attio's built-in company→people reference, and the MIRROR of the
      // person's `parent_object` below. Both directions are real in Attio and
      // both are writable, so a company's people can be written as a linked
      // write off the company (`write company-[:Team]-> { … }`) rather than
      // created loose and linked back afterwards. Multi-valued: a company has
      // many team members — which also makes it the one field in the fake that
      // can demonstrate the `+:` append markers.
      { api_slug: 'team', title: 'Team', type: 'record-reference', is_required: false, is_unique: false, is_multiselect: true, relationship: { target_object_id: 'people' } },
    ];
    for (const a of companyAttrs) {
      store.create('attio', 'attribute:companies', attioAttr('companies', a));
    }

    // Attributes for people. The `parent_object` record-reference mirrors
    // Attio's built-in field linking a person to their company; we surface
    // it so the TG framework's event-mode pruning has a real
    // record-reference attribute to look up `backingFields` against.
    const personAttrs: Parameters<typeof attioAttr>[1][] = [
      { api_slug: 'name', title: 'Name', type: 'personal-name', is_required: true, is_unique: false },
      { api_slug: 'email_addresses', title: 'Email', type: 'email-address', is_required: false, is_unique: true },
      { api_slug: 'job_title', title: 'Job Title', type: 'text', is_required: false, is_unique: false },
      {
        api_slug: 'parent_object',
        title: 'Company',
        type: 'record-reference',
        is_required: false,
        is_unique: false,
        relationship: { target_object_id: 'companies' },
      },
    ];
    for (const a of personAttrs) {
      store.create('attio', 'attribute:people', attioAttr('people', a));
    }

    // Attributes for deals. Seeded because their ABSENCE was itself a finding:
    // with none, `Deals` described as a single synthesized `Created At` and
    // read as a broken object rather than an unseeded one — a fake that is
    // wrong about the world makes the surface look wrong. The `associated_company`
    // record-reference gives deals a real edge to traverse, mirroring how a
    // real Attio deals object links to the company it belongs to.
    const dealAttrs: Parameters<typeof attioAttr>[1][] = [
      { api_slug: 'name', title: 'Name', type: 'text', is_required: true, is_unique: false },
      // A `status`, not a `select`: real Attio's deals object ships Stage as a
      // status attribute, whose values come from the `/statuses` endpoint.
      { api_slug: 'stage', title: 'Stage', type: 'status', is_required: false, is_unique: false },
      { api_slug: 'value', title: 'Value', type: 'number', is_required: false, is_unique: false },
      {
        api_slug: 'associated_company',
        title: 'Company',
        type: 'record-reference',
        is_required: false,
        is_unique: false,
        relationship: { target_object_id: 'companies' },
      },
    ];
    for (const a of dealAttrs) {
      store.create('attio', 'attribute:deals', attioAttr('deals', a));
    }

    // Default list — shape must match the real Attio API listValidator
    // (apiClient.ts:125). Missing `id.list_id` makes the api adapter's
    // Zod parse fail, which the BackOff retry treats as transient and
    // retries up to 156s before surfacing — hanging any trpc batch
    // that includes attioListLists.
    store.create('attio', 'list', {
      id: { workspace_id: 'test', list_id: 'pipeline' },
      api_slug: 'pipeline',
      name: 'Pipeline',
      parent_object: ['deals'],
    });

    // A second list scoped to Companies, with a custom Stage attribute —
    // exercises the per-list synthetic target type. Note: the system
    // entry date (`Added to list at`) is NOT seeded here, mirroring real
    // Attio (the list-attributes endpoint never returns entry metadata);
    // the adapter synthesizes it as a read-only `within` recency key.
    store.create('attio', 'list', {
      id: { workspace_id: 'test', list_id: 'vc_deal_flow' },
      api_slug: 'vc_deal_flow',
      name: 'VC Deal Flow',
      parent_object: ['companies'],
    });
    // List attribute shape mirrors the object-attribute shape above —
    // the api adapter parses both with the same attributeValidator.
    store.create('attio', 'attribute:list:vc_deal_flow', {
      id: { workspace_id: 'test', object_id: 'vc_deal_flow', attribute_id: 'stage' },
      api_slug: 'stage',
      title: 'Stage',
      description: null,
      type: 'status',
      is_multiselect: false,
      is_unique: false,
      is_required: false,
      is_writable: true,
      is_system_attribute: false,
      relationship: null,
      config: {},
    });

    // Workspace members
    store.create('attio', 'workspace_member', {
      id: { workspace_id: 'test', workspace_member_id: '1' },
      first_name: 'Test',
      last_name: 'User',
      email_address: 'test@example.com',
      avatar_url: null,
    });

    console.log('  Seeded attio: 3 objects, 12 attributes, 1 list, 1 member');
  }

  // Status options for VC Deal Flow's `Stage` attribute — makes `Stage` a real
  // enum on the per-list type (so the discriminated list-membership write
  // `{ listName: "VC Deal Flow", Stage: "Diligence" }` type-checks the value,
  // and a bogus Stage is MOV_ENUM_UNKNOWN_VALUE). Served by
  // `GET /v2/lists/vc_deal_flow/attributes/stage/statuses`. Its OWN idempotency
  // gate at TOP LEVEL (not nested under the attio-objects gate) so it heals an
  // already-seeded shared dev-loop store, adding the statuses to a VC Deal Flow
  // list that predates this block.
  if (store.list('attio', 'status:list:vc_deal_flow:stage').length === 0) {
    for (const title of ['Sourced', 'Diligence', 'Term Sheet', 'Passed']) {
      const statusId = title.toLowerCase().replace(/\s+/g, '_');
      store.create(
        'attio',
        'status:list:vc_deal_flow:stage',
        {
          id: {
            workspace_id: 'test',
            object_id: 'vc_deal_flow',
            attribute_id: 'stage',
            status_id: statusId,
          },
          title,
          is_archived: false,
        },
        statusId,
      );
    }
    console.log('  Seeded attio: 4 Stage statuses for VC Deal Flow');
  }


  // Deals `Stage` was seeded as an option-less `select`, which described as an
  // enum with no values — builders read that (correctly) as "nothing can be
  // filtered on Stage" and went looking elsewhere. Real Attio has it as a
  // `status` with its stages served by `/statuses`; upgrade stores seeded
  // before this correction in place, then give it its stages. Own top-level
  // gates so an already-seeded shared dev-loop store heals on boot. Includes
  // the stages the authoring eval seeds onto deals (Sourced/Diligence/Passed).
  for (const a of store.list('attio', 'attribute:deals')) {
    if (a.data.api_slug === 'stage' && a.data.type !== 'status') {
      store.update('attio', 'attribute:deals', a.id, { ...a.data, type: 'status' });
      console.log('  Seeded attio: deals.stage upgraded to status');
    }
  }
  if (store.list('attio', 'status:deals:stage').length === 0) {
    // Four, so the digest (which lists the first four options) shows them all.
    for (const title of ['Sourced', 'Diligence', 'Term Sheet', 'Passed']) {
      const statusId = title.toLowerCase().replace(/\s+/g, '_');
      store.create(
        'attio',
        'status:deals:stage',
        {
          id: {
            workspace_id: 'test',
            object_id: 'deals',
            attribute_id: 'stage',
            status_id: statusId,
          },
          title,
          is_archived: false,
        },
        statusId,
      );
    }
    console.log('  Seeded attio: 4 Stage statuses for Deals');
  }

  // `categories` is MULTI-select in real Attio (confirmed; the REST docs
  // pass two values). Stores seeded before this correction hold it as
  // single-valued, so upgrade in place rather than only fixing new stores —
  // otherwise the append markers stay undemonstrable on every running loop.
  for (const a of store.list('attio', 'attribute:companies')) {
    if (a.data.api_slug === 'categories' && a.data.is_multiselect !== true) {
      store.update('attio', 'attribute:companies', a.id, { ...a.data, is_multiselect: true });
      console.log('  Seeded attio: companies.categories upgraded to multi-select');
    }
  }

  // …and the OPTIONS that make it a real select. A select attribute serving no
  // options is not a thin workspace, it is an incoherent one: the checker reads
  // the empty domain as `never` (MOV_ENUM_EMPTY_DOMAIN — "nothing can use this
  // field until an option exists"), which is a true statement about a workspace
  // no real Attio account looks like. The handbook's captured fixture is a
  // capture of THIS workspace, so an option-less `Categories` made three
  // truthful chapter examples uncheckable. Same shape and same reason as the VC
  // Deal Flow `Stage` statuses above, own top-level idempotency gate included so
  // an already-seeded shared store heals on boot. Served by
  // `GET /v2/objects/companies/attributes/categories/options`.
  if (store.list('attio', 'option:companies:categories').length === 0) {
    for (const title of ['Lead', 'Customer', 'Open', 'Snoozed', 'Reviewed', 'inbound']) {
      const optionId = title.toLowerCase().replace(/\s+/g, '_');
      store.create(
        'attio',
        'option:companies:categories',
        {
          id: {
            workspace_id: 'test',
            object_id: 'companies',
            attribute_id: 'categories',
            option_id: optionId,
          },
          title,
          is_archived: false,
        },
        optionId,
      );
    }
    console.log('  Seeded attio: 6 Categories options for Companies');
  }

  // Attio's built-in company→people reference. Gated separately from the block
  // above so a store seeded before this fixture existed gains it on boot — the
  // main Attio block only runs on an EMPTY store, so an addition made there is
  // invisible to every dev loop already running.
  if (!store.list('attio', 'attribute:companies').some((a) => a.data.api_slug === 'team')) {
    store.create('attio', 'attribute:companies', attioAttr('companies', {
      api_slug: 'team',
      title: 'Team',
      type: 'record-reference',
      is_required: false,
      is_unique: false,
      is_multiselect: true,
      relationship: { target_object_id: 'people' },
    }));
    console.log('  Seeded attio: companies.team (multi-valued record-reference → people)');
  }

  // A UI-SHAPED record-reference. Every reference above is one of Attio's own
  // built-in links, which come with a paired `relationship` — so the fake could
  // not reproduce the bug where a reference created in the Attio UI (`Funds` →
  // `GPs` → People, multi-valued) never appeared as an edge: those arrive with
  // `relationship: null` and their target only in
  // `config.record_reference.allowed_object_ids`. Seeded with records on both
  // ends so the edge can actually be TRAVERSED in the loop, not just described.
  // Gated separately (like `team` above) so a store seeded before this fixture
  // existed gains it on boot.
  if (!store.list('attio', 'object').some((o) => o.data.api_slug === 'funds')) {
    store.create('attio', 'object', {
      id: { workspace_id: 'test', object_id: 'funds' },
      api_slug: 'funds',
      singular_noun: 'Fund',
      plural_noun: 'Funds',
    });
    const fundAttrs: Parameters<typeof attioAttr>[1][] = [
      { api_slug: 'name', title: 'Name', type: 'text', is_required: true, is_unique: false },
      { api_slug: 'vintage', title: 'Vintage', type: 'number', is_required: false, is_unique: false },
      {
        api_slug: 'gps',
        title: 'GPs',
        type: 'record-reference',
        is_required: false,
        is_unique: false,
        is_multiselect: true,
        // No `relationship` — the whole point of the fixture.
        allowed_object_ids: ['people'],
      },
    ];
    for (const a of fundAttrs) {
      store.create('attio', 'attribute:funds', attioAttr('funds', a));
    }

    // The far end of the edge. People had no seeded records at all, so a GPs
    // traversal would have resolved to nothing and proved nothing.
    const people = [
      { id: 'person-ada', full_name: 'Ada Lovelace', email: 'ada@example.test', job: 'General Partner' },
      { id: 'person-bo', full_name: 'Bo Reeves', email: 'bo@example.test', job: 'General Partner' },
    ];
    for (const p of people) {
      store.create('attio', 'record:people', {
        id: { workspace_id: 'test', object_id: 'people', record_id: p.id },
        values: {
          name: [{ full_name: p.full_name, first_name: p.full_name.split(' ')[0], last_name: p.full_name.split(' ')[1] }],
          email_addresses: [{ email_address: p.email }],
          job_title: [{ value: p.job }],
        },
      }, p.id);
    }

    store.create('attio', 'record:funds', {
      id: { workspace_id: 'test', object_id: 'funds', record_id: 'fund-alpha' },
      values: {
        name: [{ value: 'Alpha Fund I' }],
        vintage: [{ value: 2024 }],
        gps: people.map((p) => ({ target_object: 'people', target_record_id: p.id })),
      },
    }, 'fund-alpha');

    console.log('  Seeded attio: Funds object with a UI-shaped `GPs` record-reference (relationship: null, allowed_object_ids) + 1 fund, 2 people');
  }

  // A MULTI-TARGET UI reference: one attribute allowed to land on People AND
  // Companies. Attio's UI offers exactly this, and it is what makes an edge
  // polymorphic — the landing type is decided per record, so a traversal yields
  // a mixed set that an automation narrows with an `IS` test. Seeded with one
  // record of EACH kind on the far end, because a fixture that only ever lands
  // on one type cannot tell a working union from a lucky single target.
  //
  // Gated on the attribute itself (not on the Funds object) so a store seeded
  // before this fixture existed gains it on boot.
  if (!store.list('attio', 'attribute:funds').some((a) => a.data.api_slug === 'advisors')) {
    store.create(
      'attio',
      'attribute:funds',
      attioAttr('funds', {
        api_slug: 'advisors',
        title: 'Advisors',
        type: 'record-reference',
        is_required: false,
        is_unique: false,
        is_multiselect: true,
        allowed_object_ids: ['people', 'companies'],
      }),
    );

    if (!store.list('attio', 'record:companies').some((r) => r.id === 'company-northwind')) {
      store.create('attio', 'record:companies', {
        id: { workspace_id: 'test', object_id: 'companies', record_id: 'company-northwind' },
        values: {
          name: [{ value: 'Northwind Advisory' }],
          domains: [{ domain: 'northwind.test' }],
          description: [{ value: 'Advises the fund on structuring.' }],
        },
      }, 'company-northwind');
    }

    const fund = store.list('attio', 'record:funds').find((r) => r.id === 'fund-alpha');
    if (fund) {
      store.update('attio', 'record:funds', 'fund-alpha', {
        values: {
          ...(fund.data.values as Record<string, unknown>),
          advisors: [
            { target_object: 'people', target_record_id: 'person-ada' },
            { target_object: 'companies', target_record_id: 'company-northwind' },
          ],
        },
      });
    }

    console.log('  Seeded attio: Funds `Advisors` — a MULTI-TARGET reference (People | Companies) with one record of each on the far end');
  }

  // ── Slack ─────────────────────────────────────────────────
  if (store.list('slack', 'channel').length === 0) {
    const channels = [
      { id: 'C001', name: 'general', is_private: false, is_member: true, num_members: 10 },
      { id: 'C002', name: 'dealflow', is_private: false, is_member: true, num_members: 5 },
      { id: 'C003', name: 'portfolio', is_private: true, is_member: true, num_members: 3 },
    ];
    for (const c of channels) {
      store.create('slack', 'channel', c, c.id);
    }

    const users = [
      {
        id: 'U000',
        name: 'devloop',
        real_name: 'Dev Loop',
        deleted: false,
        // Matches DEV_LOOP_EMAIL (apps/api/src/scripts/dev/_lib.ts) — the only
        // team member `pnpm dev:seed` registers on the dev-loop team. `ada@example.com`
        // / `priya@example.com` below are NOT team members of the dev-loop team (that
        // email is claimed by a real team), so the actor-gate dev-loop proof
        // (message-write-unification-2026-07-07 Task 2) needs a fake Slack identity
        // that actually resolves as registered.
        profile: { display_name: 'devloop', real_name: 'Dev Loop', email: 'dev-loop@listen-fire.local' },
      },
      {
        id: 'U001',
        name: 'ada',
        real_name: 'Ada Okafor',
        deleted: false,
        profile: { display_name: 'ada', real_name: 'Ada Okafor', email: 'ada@example.com' },
      },
      {
        id: 'U002',
        name: 'priya',
        real_name: 'Priya Ops',
        deleted: false,
        profile: { display_name: 'priya', real_name: 'Priya Ops', email: 'priya@example.com' },
      },
    ];
    for (const u of users) {
      store.create('slack', 'user', u, u.id);
    }
    for (const [channel, members] of [['C002', ['U000', 'U001', 'U002']], ['C001', ['U001']]] as const) {
      for (const m of members) {
        store.create('slack', `members:${channel}`, {}, m);
      }
    }

    // Dealflow history: two top-level messages, one carrying a thread.
    const messages = [
      { channel: 'C002', ts: '1751500000.000100', user: 'U001', text: 'New deal: Acme wants a term sheet' },
      { channel: 'C002', ts: '1751500100.000200', user: 'U002', text: 'Metrics deck attached for Foo Corp' },
      { channel: 'C002', ts: '1751500200.000300', user: 'U002', text: 'Acme follow-up: revenue is 1.2M ARR', thread_ts: '1751500000.000100' },
    ];
    for (const m of messages) {
      store.create('slack', 'message', m, m.ts);
    }
    console.log('  Seeded slack: 3 channels, 3 users, 3 messages');
  }

  // ── Google Drive ──────────────────────────────────────────
  if (store.list('gdrive', 'file').length === 0) {
    store.create('gdrive', 'file', {
      id: 'fold-deals',
      name: 'Deals',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root'],
      webViewLink: 'https://drive.google.com/drive/folders/fold-deals',
      content: null,
      size: null,
    }, 'fold-deals');
    store.create('gdrive', 'file', {
      id: 'file-memo',
      name: 'acme-memo.txt',
      mimeType: 'text/plain',
      parents: ['fold-deals'],
      webViewLink: 'https://drive.google.com/file/d/file-memo',
      content: 'Acme investment memo: ARR 1.2M, growing 8% MoM.',
      size: 47,
    }, 'file-memo');
    console.log('  Seeded gdrive: 1 folder, 1 file');
  }

  // ── Dropbox ───────────────────────────────────────────────
  if (store.list('dropbox', 'entry').length === 0) {
    store.create('dropbox', 'entry', {
      path: '/Deals', name: 'Deals', isFolder: true, size: null, content: null,
    }, '/Deals');
    store.create('dropbox', 'entry', {
      path: '/Deals/foo-notes.txt',
      name: 'foo-notes.txt',
      isFolder: false,
      size: 38,
      content: 'Foo Corp notes: strong team, pre-seed.',
    }, '/Deals/foo-notes.txt');
    console.log('  Seeded dropbox: 1 folder, 1 file');
  }

  // ── Airtable ──────────────────────────────────────────────
  if (store.list('airtable', 'base').length === 0) {
    // TWO bases, deliberately. A drill-down (meta → one base → its tables) and
    // a full-workspace walk are indistinguishable against a single-base
    // workspace — both cost one `listTables`. With a second base, only the
    // walk touches `appTEST002`, so the dev loop can tell them apart.
    // See plans/2026-07-10-adapter-entry-positions/2_type_space.md.
    store.create('airtable', 'base', { id: 'appTEST001', name: 'Pipeline Tracker' }, 'appTEST001');
    store.create('airtable', 'base', { id: 'appTEST002', name: 'Ops' }, 'appTEST002');

    // primaryFieldId is REQUIRED by the adapter's listTablesResponseParser — a
    // table missing it Zod-fails introspection and triggers the client's
    // 5-retry exponential backoff (~156s) on every airtable catalog load.
    const tablesByBase: Record<string, unknown[]> = {
      appTEST001: [
        { id: 'tblCOMPANIES', name: 'Companies', primaryFieldId: 'fldName', fields: [
          { id: 'fldName', name: 'Name', type: 'singleLineText' },
          { id: 'fldStage', name: 'Stage', type: 'singleSelect' },
          { id: 'fldNotes', name: 'Notes', type: 'multilineText' },
        ]},
        { id: 'tblCONTACTS', name: 'Contacts', primaryFieldId: 'fldFullName', fields: [
          { id: 'fldFullName', name: 'Full Name', type: 'singleLineText' },
          { id: 'fldEmail', name: 'Email', type: 'email' },
          { id: 'fldCompany', name: 'Company', type: 'multipleRecordLinks' },
        ]},
      ],
      appTEST002: [
        { id: 'tblVENDORS', name: 'Vendors', primaryFieldId: 'fldVendor', fields: [
          { id: 'fldVendor', name: 'Vendor', type: 'singleLineText' },
          { id: 'fldSpend', name: 'Spend', type: 'currency' },
        ]},
      ],
    };
    for (const [baseId, tables] of Object.entries(tablesByBase)) {
      for (const t of tables as { id: string }[]) {
        store.create('airtable', `table:${baseId}`, t, t.id);
      }
    }
    console.log('  Seeded airtable: 2 bases, 3 tables');
  }

  // ── Google Sheets ─────────────────────────────────────────
  if (store.list('sheets', 'spreadsheet').length === 0) {
    store.create('sheets', 'spreadsheet', {
      spreadsheetId: 'test-spreadsheet-001',
      properties: { title: 'Pipeline Sheet' },
      sheets: [
        {
          properties: { sheetId: 0, title: 'Companies', gridProperties: { columnCount: 26 } },
          // Real Sheets API shape: GridRange object + columnName'd columns —
          // the api client's listTables skips tables that don't parse (and a
          // falsy tableId like 0 is skipped outright).
          tables: [
            {
              tableId: 'table-companies',
              name: 'Companies',
              range: { startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 },
              columnProperties: [
                { columnIndex: 0, columnName: 'Name', columnType: 'TEXT' },
                { columnIndex: 1, columnName: 'Stage', columnType: 'TEXT' },
                { columnIndex: 2, columnName: 'Domain', columnType: 'TEXT' },
                { columnIndex: 3, columnName: 'Notes', columnType: 'TEXT' },
              ],
            },
          ],
        },
      ],
      namedRanges: [
        {
          namedRangeId: 'nr-fx',
          name: 'FX_Rate',
          range: { sheetId: 0, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 1, endColumnIndex: 2 },
        },
      ],
    }, 'test-spreadsheet-001');
    console.log('  Seeded sheets: 1 spreadsheet');
  }

  // A PLAIN-TAB spreadsheet: tab "Sheet1" with a header row but NO native Table
  // — the bare-sheet append surface (`"Sheet1 (sheet)"`). `headerRow` is the
  // fake's model of row 1, served by the Values GET on a `!1:…` range. Guarded
  // per-fixture so it seeds into stores already carrying the native-table one.
  if (!store.get('sheets', 'spreadsheet', 'test-spreadsheet-plain')) {
    store.create('sheets', 'spreadsheet', {
      spreadsheetId: 'test-spreadsheet-plain',
      properties: { title: 'Dealflow Log' },
      sheets: [
        {
          properties: { sheetId: 0, title: 'Sheet1', gridProperties: { columnCount: 26 } },
          tables: [],
          headerRow: ['Timestamp', 'Sender', 'Message', 'Company'],
        },
      ],
    }, 'test-spreadsheet-plain');
    console.log('  Seeded sheets: plain-tab spreadsheet (Dealflow Log / Sheet1)');
  }

  // Two spreadsheets the dev store GRANTS but the fake never held, so their
  // grant hops 404'd (google_granted_item rows from 2026-07-05 live testing:
  // `picked-042` was minted by the picker flow without a store entity;
  // `created-2` was created against a different profile's store). Seeded
  // additively so every grant the dev credential holds is live — the
  // stale-grant DATA half of the 2026-07-17 sheets graph pass; the GAP half
  // (the hop silently degrading a 404 to "no leaves") is fixed in the adapter.
  if (!store.get('sheets', 'spreadsheet', 'picked-042')) {
    store.create('sheets', 'spreadsheet', {
      spreadsheetId: 'picked-042',
      properties: { title: 'LP Commitments' },
      sheets: [
        {
          properties: { sheetId: 0, title: 'LPs', gridProperties: { columnCount: 26 } },
          tables: [
            {
              tableId: 'table-lps',
              name: 'LPs',
              range: { startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 },
              columnProperties: [
                { columnIndex: 0, columnName: 'LP Name', columnType: 'TEXT' },
                { columnIndex: 1, columnName: 'Commitment', columnType: 'CURRENCY' },
                { columnIndex: 2, columnName: 'Status', columnType: 'TEXT' },
              ],
            },
          ],
        },
      ],
    }, 'picked-042');
    console.log('  Seeded sheets: LP Commitments (picked-042)');
  }
  if (!store.get('sheets', 'spreadsheet', 'created-2')) {
    store.create('sheets', 'spreadsheet', {
      spreadsheetId: 'created-2',
      properties: { title: 'Shared Metrics' },
      sheets: [
        {
          properties: { sheetId: 0, title: 'Summary', gridProperties: { columnCount: 26 } },
          tables: [],
          headerRow: ['Metric', 'Value', 'As Of'],
        },
      ],
      namedRanges: [
        {
          namedRangeId: 'nr-total-arr',
          name: 'Total_ARR',
          range: { sheetId: 0, startRowIndex: 9, endRowIndex: 10, startColumnIndex: 1, endColumnIndex: 2 },
        },
      ],
    }, 'created-2');
    console.log('  Seeded sheets: Shared Metrics (created-2)');
  }

  // ── Evertrace ─────────────────────────────────────────────
  // Two companies + two schools (lookup entities the signal experiences/
  // educations embed inline, matching the real API's shape), four signals
  // spanning distinct signal types via taggings, two saved searches whose
  // stored filter rows cover the value and operator shapes the adapter has to
  // read, and one list holding one of the signals.
  if (store.list('evertrace', 'signal').length === 0) {
    const WS = 'ws_dev_loop';
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const northwind = {
      id: 'exe_1', source: 'evertrace', name: 'Northwind Robotics',
      websiteUrl: 'https://northwind.robotics', customerSegment: 'B2B',
      sourceUrl: null, logoUrl: null, employeeCount: 42,
      createdAt: now - 200 * day, updatedAt: now - 10 * day,
    };
    const bluepeak = {
      id: 'exe_2', source: 'evertrace', name: 'Bluepeak Systems',
      websiteUrl: 'https://bluepeak.systems', customerSegment: 'B2B',
      sourceUrl: null, logoUrl: null, employeeCount: 11,
      createdAt: now - 400 * day, updatedAt: now - 30 * day,
    };
    store.create('evertrace', 'company', northwind, northwind.id);
    store.create('evertrace', 'company', bluepeak, bluepeak.id);

    const stanford = {
      id: 'ede_1', name: 'Stanford University', sourceUrl: null, logoUrl: null,
      studentCount: 17000, createdAt: now - 3000 * day, updatedAt: now - 3000 * day,
    };
    const mit = {
      id: 'ede_2', name: 'MIT', sourceUrl: null, logoUrl: null,
      studentCount: 11000, createdAt: now - 3000 * day, updatedAt: now - 3000 * day,
    };
    store.create('evertrace', 'education', stanford, stanford.id);
    store.create('evertrace', 'education', mit, mit.id);

    const tagging = (id: string, signalId: string, key: string) => ({
      id, key, namespace: 'signal_type', signalId, createdAt: now, updatedAt: now,
    });

    const signals = [
      {
        id: 'sig_1', score: 8, source: 'linkedin', firstName: 'Priya', lastName: 'Narayanan',
        imageUrl: null, nationality: 'American', description: null, city: 'San Francisco',
        country: 'United States', gender: 'woman', githubSlug: null, linkedinIdIm: null,
        linkedinIdStr: 'priya-narayanan', signalHash: 'hash_sig_1', profileAccuracy: 'high',
        age: '30 to 34', discoveredAt: now - 1 * day, twitterId: null, email: null,
        stealthSign: null, stealthReason: null, summary: 'Left stealth to found a robotics company.',
        createdAt: now - 1 * day, taggings: [tagging('tg_1', 'sig_1', 'New Company')],
        experiences: [
          { id: 'exp_1', signalId: 'sig_1', experienceEntityId: northwind.id, title: 'Founder & CEO',
            location: 'San Francisco', companyName: northwind.name, indexOrder: 0,
            startDate: '2026-06', endDate: null, createdAt: now, updatedAt: now, entity: northwind },
        ],
        educations: [
          { id: 'edu_1', signalId: 'sig_1', educationEntityId: stanford.id, degree: 'BS Computer Science',
            schoolName: stanford.name, indexOrder: 0, startDate: '2014', endDate: '2018',
            createdAt: now, updatedAt: now, entity: stanford },
        ],
        region: null, unipileMessagesCount: 0, unipileInvitationsCount: 0,
      },
      {
        id: 'sig_2', score: 6, source: 'linkedin', firstName: 'Marcus', lastName: 'Webb',
        imageUrl: null, nationality: 'British', description: null, city: 'London',
        country: 'United Kingdom', gender: 'man', githubSlug: null, linkedinIdIm: null,
        linkedinIdStr: 'marcus-webb', signalHash: 'hash_sig_2', profileAccuracy: 'medium',
        age: '35 to 39', discoveredAt: now - 3 * day, twitterId: null, email: null,
        stealthSign: 'title change', stealthReason: 'New LinkedIn headline: "Building something new."',
        summary: null, createdAt: now - 3 * day, taggings: [tagging('tg_2', 'sig_2', 'Stealth Position')],
        experiences: [
          { id: 'exp_2', signalId: 'sig_2', experienceEntityId: null, title: 'Stealth', location: 'London',
            companyName: null, indexOrder: 0, startDate: '2026-05', endDate: null,
            createdAt: now, updatedAt: now, entity: null },
        ],
        educations: [
          { id: 'edu_2', signalId: 'sig_2', educationEntityId: mit.id, degree: 'MBA', schoolName: mit.name,
            indexOrder: 0, startDate: '2012', endDate: '2014', createdAt: now, updatedAt: now, entity: mit },
        ],
        region: null, unipileMessagesCount: 0, unipileInvitationsCount: 0,
      },
      {
        id: 'sig_3', score: 5, source: 'linkedin', firstName: 'Ana', lastName: 'Costa',
        imageUrl: null, nationality: 'Portuguese', description: null, city: 'Lisbon',
        country: 'Portugal', gender: 'woman', githubSlug: null, linkedinIdIm: null,
        linkedinIdStr: 'ana-costa', signalHash: 'hash_sig_3', profileAccuracy: 'medium',
        age: '25 to 29', discoveredAt: now - 5 * day, twitterId: null, email: null,
        stealthSign: null, stealthReason: null, summary: null, createdAt: now - 5 * day,
        taggings: [tagging('tg_3', 'sig_3', 'Left Position')],
        experiences: [
          { id: 'exp_3', signalId: 'sig_3', experienceEntityId: bluepeak.id, title: 'Former VP Engineering',
            location: 'Lisbon', companyName: bluepeak.name, indexOrder: 0, startDate: '2022-01',
            endDate: '2026-08', createdAt: now, updatedAt: now, entity: bluepeak },
        ],
        educations: [],
        region: null, unipileMessagesCount: 0, unipileInvitationsCount: 0,
      },
      {
        id: 'sig_4', score: 7, source: 'patent-office', firstName: 'Kenji', lastName: 'Sato',
        imageUrl: null, nationality: 'Japanese', description: null, city: 'Tokyo',
        country: 'Japan', gender: 'man', githubSlug: null, linkedinIdIm: null,
        linkedinIdStr: 'kenji-sato', signalHash: 'hash_sig_4', profileAccuracy: 'high',
        age: '40 to 44', discoveredAt: now - 7 * day, twitterId: null, email: null,
        stealthSign: null, stealthReason: null, summary: 'Filed a new patent in battery chemistry.',
        createdAt: now - 7 * day, taggings: [tagging('tg_4', 'sig_4', 'New Patent')],
        experiences: [], educations: [],
        region: null, unipileMessagesCount: 0, unipileInvitationsCount: 0,
      },
    ];
    for (const s of signals) store.create('evertrace', 'signal', s, s.id);

    // The stored rows are in Evertrace's own shape, not the request body's:
    // the signal kind is filed under `status`, and a value arrives as a JSON
    // array string. The adapter translates both — seeding anything tidier
    // would exercise a translation nothing real produces.
    store.create(
      'evertrace',
      'search',
      {
        id: 'srch_1', workspaceId: WS, emoji: '🕵️', title: 'Stealth founders', createdBy: 'usr_1',
        updatedBy: 'usr_1', createdAt: now, updatedAt: now, visitedAt: now, visitedBy: 'usr_1',
        orderIndex: '0', sharees: [],
        filters: [
          { id: 'sfr_1', searchId: 'srch_1', key: 'status', operator: 'in', value: '["Stealth Position"]',
            workspaceId: WS, createdAt: now, updatedAt: now },
        ],
      },
      'srch_1',
    );

    // A second search covering the other two shapes: a scalar bound, and an
    // exclude — which only travels on the keys Evertrace negates with a `!`.
    store.create(
      'evertrace',
      'search',
      {
        id: 'srch_2', workspaceId: WS, emoji: '🌍', title: 'Strong outside Japan', createdBy: 'usr_1',
        updatedBy: 'usr_1', createdAt: now, updatedAt: now, visitedAt: now, visitedBy: 'usr_1',
        orderIndex: '1', sharees: [],
        filters: [
          { id: 'sfr_2', searchId: 'srch_2', key: 'score', operator: 'gte', value: '7',
            workspaceId: WS, createdAt: now, updatedAt: now },
          { id: 'sfr_3', searchId: 'srch_2', key: 'country', operator: 'not_in', value: 'Japan',
            workspaceId: WS, createdAt: now, updatedAt: now },
        ],
      },
      'srch_2',
    );

    store.create(
      'evertrace',
      'list',
      { id: 'list_1', workspaceId: WS, createdBy: 'usr_1', name: 'Pipeline', createdAt: now, updatedAt: now },
      'list_1',
    );
    // A second, empty list: "every list" then means more than one, and a
    // listener scoped to Pipeline has somewhere else an entry can land.
    store.create(
      'evertrace',
      'list',
      { id: 'list_2', workspaceId: WS, createdBy: 'usr_1', name: 'Watchlist', createdAt: now, updatedAt: now },
      'list_2',
    );
    store.create(
      'evertrace',
      'listEntry',
      { id: 'entry_1', workspaceId: WS, listId: 'list_1', signalId: 'sig_1', addedBy: 'usr_1', createdAt: now, updatedAt: now },
      'entry_1',
    );

    console.log('  Seeded evertrace: 2 companies, 2 schools, 4 signals, 2 searches (Stealth founders, Strong outside Japan), 2 lists (Pipeline with 1 entry, Watchlist)');
  }

  // ── Dealroom ──────────────────────────────────────────────
  // 8 companies (3 industries × 3 countries, mixed growth stages), 6
  // investors (3 VC, 2 angel, 1 corporate), 12 people (founders + a few
  // executives, three of them doing double duty as a venture partner too —
  // team membership is a company/investor↔person join either way), 12 rounds
  // over the last 3 years with lead flags, and the joins the adapter's graph
  // walks (round_investor, company_investor, team_membership, fund). All
  // timestamps are fixed strings, not `now()` — sort/filter tests must be
  // stable across runs. Two rounds (R4, R12) carry recent `created_utc` so a
  // poll after a checkpoint has something to return without the admin seed.
  if (store.list('dealroom', 'company').length === 0) {
    const loc = (id: number, city: string, country: string, continent: string, lat: number, lon: number) =>
      mkLocation({ id, city, country, continent, lat, lon });

    const companies = [
      {
        id: '1', name: 'Nimbusly', path: 'nimbusly', tagline: 'Cash flow forecasting for SMBs',
        about: 'Nimbusly gives small businesses a real-time picture of their cash position.',
        website_url: 'https://nimbusly.io', linkedin_url: 'https://www.linkedin.com/company/nimbusly/', twitter_url: null,
        employees: '11-50', employees_latest: 38, growth_stage: 'early stage', company_status: 'active',
        launch_year: 2022, launch_month: 3,
        industries: mkParams(['Fintech'], 101), sub_industries: mkParams(['Accounting Software'], 201),
        technologies: mkParams(['Open Banking'], 301), tags: mkParams(['SMB', 'Cash Flow'], 401),
        hq_locations: [loc(1001, 'San Francisco', 'United States', 'North America', 37.7749, -122.4194)],
        job_openings: 4, patents_count: 0, has_strong_founder: true, has_super_founder: false, has_promising_founder: false,
        last_updated: '2026-08-01T09:00:00+00:00', last_updated_utc: '2026-08-01 09:00:00', created_utc: '2022-03-10 12:00:00',
      },
      {
        id: '2', name: 'Ledgerly', path: 'ledgerly', tagline: 'Bookkeeping automation for freelancers',
        about: 'Ledgerly reconciles invoices and receipts automatically for freelance professionals.',
        website_url: 'https://ledgerly.co.uk', linkedin_url: 'https://www.linkedin.com/company/ledgerly/', twitter_url: null,
        employees: '2-10', employees_latest: 9, growth_stage: 'seed stage', company_status: 'active',
        launch_year: 2023, launch_month: 1,
        industries: mkParams(['Fintech'], 102), sub_industries: mkParams(['Bookkeeping'], 202),
        technologies: mkParams(['OCR'], 302), tags: mkParams(['Freelance'], 402),
        hq_locations: [loc(1002, 'London', 'United Kingdom', 'Europe', 51.5072, -0.1276)],
        job_openings: 2, patents_count: 0, has_strong_founder: true, has_super_founder: false, has_promising_founder: true,
        last_updated: '2026-07-20T09:00:00+00:00', last_updated_utc: '2026-07-20 09:00:00', created_utc: '2023-01-05 12:00:00',
      },
      {
        id: '3', name: 'Vaultwise', path: 'vaultwise', tagline: 'Treasury management for scale-ups',
        about: 'Vaultwise helps growth-stage companies manage multi-currency treasury operations.',
        website_url: 'https://vaultwise.de', linkedin_url: 'https://www.linkedin.com/company/vaultwise/', twitter_url: null,
        employees: '51-200', employees_latest: 140, growth_stage: 'late stage', company_status: 'active',
        launch_year: 2020, launch_month: 6,
        industries: mkParams(['Fintech'], 103), sub_industries: mkParams(['Treasury Management'], 203),
        technologies: mkParams(['Payments Infrastructure'], 303), tags: mkParams(['Treasury', 'B2B'], 403),
        hq_locations: [loc(1003, 'Berlin', 'Germany', 'Europe', 52.52, 13.405)],
        job_openings: 9, patents_count: 1, has_strong_founder: true, has_super_founder: true, has_promising_founder: false,
        last_updated: '2026-09-01T09:00:00+00:00', last_updated_utc: '2026-09-01 09:00:00', created_utc: '2020-06-15 12:00:00',
      },
      {
        id: '4', name: 'Carewave', path: 'carewave', tagline: 'Remote patient monitoring platform',
        about: 'Carewave connects chronic care patients to their clinical teams between visits.',
        website_url: 'https://carewave.health', linkedin_url: 'https://www.linkedin.com/company/carewave/', twitter_url: null,
        employees: '201-500', employees_latest: 310, growth_stage: 'breakout stage', company_status: 'active',
        launch_year: 2019, launch_month: 9,
        industries: mkParams(['HealthTech'], 104), sub_industries: mkParams(['Remote Monitoring'], 204),
        technologies: mkParams(['Wearables'], 304), tags: mkParams(['Chronic Care'], 404),
        hq_locations: [loc(1004, 'Boston', 'United States', 'North America', 42.3601, -71.0589)],
        job_openings: 14, patents_count: 3, has_strong_founder: true, has_super_founder: true, has_promising_founder: false,
        last_updated: '2026-09-05T09:00:00+00:00', last_updated_utc: '2026-09-05 09:00:00', created_utc: '2019-09-20 12:00:00',
      },
      {
        id: '5', name: 'Curely', path: 'curely', tagline: 'Async triage for primary care clinics',
        about: 'Curely lets primary care clinics triage patient messages without a phone queue.',
        website_url: 'https://curely.io', linkedin_url: 'https://www.linkedin.com/company/curely/', twitter_url: null,
        employees: '11-50', employees_latest: 22, growth_stage: 'early stage', company_status: 'active',
        launch_year: 2023, launch_month: 4,
        industries: mkParams(['HealthTech'], 105), sub_industries: mkParams(['Clinic Operations'], 205),
        technologies: mkParams(['Messaging'], 305), tags: mkParams(['Primary Care'], 405),
        hq_locations: [loc(1005, 'London', 'United Kingdom', 'Europe', 51.5072, -0.1276)],
        job_openings: 3, patents_count: 0, has_strong_founder: false, has_super_founder: false, has_promising_founder: true,
        last_updated: '2026-08-15T09:00:00+00:00', last_updated_utc: '2026-08-15 09:00:00', created_utc: '2023-04-02 12:00:00',
      },
      {
        id: '6', name: 'Pulsegrid', path: 'pulsegrid', tagline: 'Staffing analytics for hospital networks',
        about: 'Pulsegrid forecasts hospital staffing needs from historical admissions data.',
        website_url: 'https://pulsegrid.de', linkedin_url: 'https://www.linkedin.com/company/pulsegrid/', twitter_url: null,
        employees: '2-10', employees_latest: 7, growth_stage: 'seed stage', company_status: 'active',
        launch_year: 2023, launch_month: 2,
        industries: mkParams(['HealthTech'], 106), sub_industries: mkParams(['Workforce Analytics'], 206),
        technologies: mkParams(['Forecasting Models'], 306), tags: mkParams(['Hospitals'], 406),
        hq_locations: [loc(1006, 'Munich', 'Germany', 'Europe', 48.1351, 11.582)],
        job_openings: 1, patents_count: 0, has_strong_founder: false, has_super_founder: false, has_promising_founder: false,
        last_updated: '2026-06-10T09:00:00+00:00', last_updated_utc: '2026-06-10 09:00:00', created_utc: '2023-02-01 12:00:00',
      },
      {
        id: '7', name: 'Codeforge', path: 'codeforge', tagline: 'Build caching for monorepos',
        about: 'Codeforge is a remote build cache and task orchestrator for large monorepos.',
        website_url: 'https://codeforge.dev', linkedin_url: 'https://www.linkedin.com/company/codeforge/', twitter_url: null,
        employees: '11-50', employees_latest: 26, growth_stage: 'late stage', company_status: 'active',
        launch_year: 2021, launch_month: 5,
        industries: mkParams(['Developer Tools'], 107), sub_industries: mkParams(['Build Systems'], 207),
        technologies: mkParams(['Distributed Caching'], 307), tags: mkParams(['Monorepo', 'CI/CD'], 407),
        hq_locations: [loc(1007, 'Austin', 'United States', 'North America', 30.2672, -97.7431)],
        job_openings: 6, patents_count: 0, has_strong_founder: true, has_super_founder: false, has_promising_founder: false,
        last_updated: '2026-08-25T09:00:00+00:00', last_updated_utc: '2026-08-25 09:00:00', created_utc: '2021-05-18 12:00:00',
      },
      {
        id: '8', name: 'Devsloop', path: 'devsloop', tagline: 'Preview environments on every pull request',
        about: 'Devsloop spins up a full preview environment for every pull request automatically.',
        website_url: 'https://devsloop.dev', linkedin_url: 'https://www.linkedin.com/company/devsloop/', twitter_url: null,
        employees: '2-10', employees_latest: 6, growth_stage: 'early stage', company_status: 'active',
        launch_year: 2024, launch_month: 1,
        industries: mkParams(['Developer Tools'], 108), sub_industries: mkParams(['Preview Environments'], 208),
        technologies: mkParams(['Kubernetes'], 308), tags: mkParams(['DevOps'], 408),
        hq_locations: [loc(1008, 'Berlin', 'Germany', 'Europe', 52.52, 13.405)],
        job_openings: 2, patents_count: 0, has_strong_founder: false, has_super_founder: false, has_promising_founder: true,
        last_updated: '2026-09-02T09:00:00+00:00', last_updated_utc: '2026-09-02 09:00:00', created_utc: '2024-01-08 12:00:00',
      },
    ];
    for (const c of companies) store.create('dealroom', 'company', c, c.id);

    const investors = [
      {
        id: '1', name: 'Northbridge Ventures', path: 'northbridge_ventures', investor_type: 'Venture Capital',
        tagline: 'Early to growth stage fintech and healthtech investor', about: 'Northbridge backs fintech and healthtech founders from seed to growth.',
        website_url: 'https://northbridge.vc', linkedin_url: 'https://www.linkedin.com/company/northbridge-ventures/',
        employees: '11-50', employees_latest: 24, deal_size: '$2M-$20M', launch_year: 2014,
        investment_stages: mkParams(['Series A', 'Series B'], 501), industry_experience: mkParams(['Fintech', 'HealthTech'], 601),
        location_experience: mkParams(['North America', 'Europe'], 701), tags: mkParams(['B2B'], 801),
        hq_locations: [loc(1101, 'San Francisco', 'United States', 'North America', 37.7749, -122.4194)],
        last_updated: '2026-09-01T09:00:00+00:00', last_updated_utc: '2026-09-01 09:00:00', created_utc: '2014-01-10 12:00:00',
      },
      {
        id: '2', name: 'Solstice Capital', path: 'solstice_capital', investor_type: 'Venture Capital',
        tagline: 'Seed specialist backing European fintech', about: 'Solstice writes first checks into European fintech and dev-tools founders.',
        website_url: 'https://solsticecap.com', linkedin_url: 'https://www.linkedin.com/company/solstice-capital/',
        employees: '2-10', employees_latest: 8, deal_size: '$200K-$3M', launch_year: 2018,
        investment_stages: mkParams(['Pre-Seed', 'Seed', 'Series A'], 502), industry_experience: mkParams(['Fintech', 'Developer Tools'], 602),
        location_experience: mkParams(['Europe'], 702), tags: mkParams(['Seed'], 802),
        hq_locations: [loc(1102, 'London', 'United Kingdom', 'Europe', 51.5072, -0.1276)],
        last_updated: '2026-08-28T09:00:00+00:00', last_updated_utc: '2026-08-28 09:00:00', created_utc: '2018-03-01 12:00:00',
      },
      {
        id: '3', name: 'Ferrovia Partners', path: 'ferrovia_partners', investor_type: 'Venture Capital',
        tagline: 'DACH-region growth investor', about: 'Ferrovia backs founders across the DACH region from seed through growth.',
        website_url: 'https://ferrovia.partners', linkedin_url: 'https://www.linkedin.com/company/ferrovia-partners/',
        employees: '11-50', employees_latest: 19, deal_size: '$1M-$25M', launch_year: 2011,
        investment_stages: mkParams(['Seed', 'Series A', 'Series B'], 503), industry_experience: mkParams(['Fintech', 'HealthTech', 'Developer Tools'], 603),
        location_experience: mkParams(['Europe'], 703), tags: mkParams(['DACH'], 803),
        hq_locations: [loc(1103, 'Berlin', 'Germany', 'Europe', 52.52, 13.405)],
        last_updated: '2026-09-03T09:00:00+00:00', last_updated_utc: '2026-09-03 09:00:00', created_utc: '2011-06-01 12:00:00',
      },
      {
        id: '4', name: 'Elena Krauss', path: 'elena_krauss', investor_type: 'Angel Investor',
        tagline: 'Fintech operator turned angel', about: 'Elena angel-invests in fintech and healthtech after a decade operating payments companies.',
        website_url: null, linkedin_url: 'https://www.linkedin.com/in/elena-krauss/',
        employees: null, employees_latest: null, deal_size: '$25K-$150K', launch_year: 2019,
        investment_stages: mkParams(['Pre-Seed', 'Seed'], 504), industry_experience: mkParams(['Fintech', 'HealthTech'], 604),
        location_experience: mkParams(['Europe'], 704), tags: mkParams(['Angel'], 804),
        hq_locations: [loc(1104, 'Berlin', 'Germany', 'Europe', 52.52, 13.405)],
        last_updated: '2026-07-15T09:00:00+00:00', last_updated_utc: '2026-07-15 09:00:00', created_utc: '2019-05-20 12:00:00',
      },
      {
        id: '5', name: 'Marcus Boone', path: 'marcus_boone', investor_type: 'Angel Investor',
        tagline: 'Serial founder and angel investor', about: 'Marcus angel-invests after two exits in healthtech and fintech.',
        website_url: null, linkedin_url: 'https://www.linkedin.com/in/marcus-boone/',
        employees: null, employees_latest: null, deal_size: '$25K-$100K', launch_year: 2017,
        investment_stages: mkParams(['Seed'], 505), industry_experience: mkParams(['Fintech', 'HealthTech'], 605),
        location_experience: mkParams(['North America'], 705), tags: mkParams(['Angel'], 805),
        hq_locations: [loc(1105, 'San Francisco', 'United States', 'North America', 37.7749, -122.4194)],
        last_updated: '2026-06-30T09:00:00+00:00', last_updated_utc: '2026-06-30 09:00:00', created_utc: '2017-02-14 12:00:00',
      },
      {
        id: '6', name: 'Atlas Industrial Holdings', path: 'atlas_industrial_holdings', investor_type: 'Corporate Investor',
        tagline: 'Corporate venture arm investing in healthtech', about: 'Atlas is the corporate venture arm of a hospital operator, investing in care-delivery technology.',
        website_url: 'https://atlasindustrial.example', linkedin_url: 'https://www.linkedin.com/company/atlas-industrial-holdings/',
        employees: '51-200', employees_latest: 60, deal_size: '$5M-$40M', launch_year: 2016,
        investment_stages: mkParams(['Series B', 'Series C'], 506), industry_experience: mkParams(['HealthTech'], 606),
        location_experience: mkParams(['North America'], 706), tags: mkParams(['Corporate'], 806),
        hq_locations: [loc(1106, 'Boston', 'United States', 'North America', 42.3601, -71.0589)],
        last_updated: '2026-08-10T09:00:00+00:00', last_updated_utc: '2026-08-10 09:00:00', created_utc: '2016-09-01 12:00:00',
      },
    ];
    for (const i of investors) store.create('dealroom', 'investor', i, i.id);

    const people = [
      { id: '1', name: 'Priya Anand', path: 'priya_anand', tagline: 'CEO & Co-Founder, Nimbusly', linkedin_url: 'https://www.linkedin.com/in/priya-anand/', twitter_url: null, website_url: null,
        gender: 'female', is_founder: true, is_serial_founder: false, is_strong_founder: true, is_super_founder: false, is_promising_founder: false,
        founder_score: 78, founded_companies_total_funding: 16.5, backgrounds: mkParams(['Product'], 901),
        hq_locations: [loc(1201, 'San Francisco', 'United States', 'North America', 37.7749, -122.4194)],
        last_updated: '2026-08-01T09:00:00+00:00', last_updated_utc: '2026-08-01 09:00:00', created_utc: '2022-03-10 12:00:00' },
      { id: '2', name: 'Tom Ridley', path: 'tom_ridley', tagline: 'CTO & Co-Founder, Nimbusly · Venture Partner, Northbridge Ventures', linkedin_url: 'https://www.linkedin.com/in/tom-ridley/', twitter_url: null, website_url: null,
        gender: 'male', is_founder: true, is_serial_founder: false, is_strong_founder: true, is_super_founder: false, is_promising_founder: false,
        founder_score: 74, founded_companies_total_funding: 16.5, backgrounds: mkParams(['Engineering'], 902),
        hq_locations: [loc(1202, 'San Francisco', 'United States', 'North America', 37.7749, -122.4194)],
        last_updated: '2026-08-01T09:00:00+00:00', last_updated_utc: '2026-08-01 09:00:00', created_utc: '2022-03-10 12:00:00' },
      { id: '3', name: 'Sofia Marchetti', path: 'sofia_marchetti', tagline: 'CEO & Founder, Ledgerly', linkedin_url: 'https://www.linkedin.com/in/sofia-marchetti/', twitter_url: null, website_url: null,
        gender: 'female', is_founder: true, is_serial_founder: false, is_strong_founder: true, is_super_founder: false, is_promising_founder: true,
        founder_score: 70, founded_companies_total_funding: 10.8, backgrounds: mkParams(['Finance'], 903),
        hq_locations: [loc(1203, 'London', 'United Kingdom', 'Europe', 51.5072, -0.1276)],
        last_updated: '2026-07-20T09:00:00+00:00', last_updated_utc: '2026-07-20 09:00:00', created_utc: '2023-01-05 12:00:00' },
      { id: '4', name: 'Hugo Bennett', path: 'hugo_bennett', tagline: 'CEO & Co-Founder, Vaultwise', linkedin_url: 'https://www.linkedin.com/in/hugo-bennett/', twitter_url: null, website_url: null,
        gender: 'male', is_founder: true, is_serial_founder: true, is_strong_founder: true, is_super_founder: true, is_promising_founder: false,
        founder_score: 91, founded_companies_total_funding: 39, backgrounds: mkParams(['Operations'], 904),
        hq_locations: [loc(1204, 'Berlin', 'Germany', 'Europe', 52.52, 13.405)],
        last_updated: '2026-09-01T09:00:00+00:00', last_updated_utc: '2026-09-01 09:00:00', created_utc: '2020-06-15 12:00:00' },
      { id: '5', name: 'Lena Fischer', path: 'lena_fischer', tagline: 'COO & Co-Founder, Vaultwise · Venture Partner, Solstice Capital', linkedin_url: 'https://www.linkedin.com/in/lena-fischer/', twitter_url: null, website_url: null,
        gender: 'female', is_founder: true, is_serial_founder: false, is_strong_founder: true, is_super_founder: true, is_promising_founder: false,
        founder_score: 88, founded_companies_total_funding: 39, backgrounds: mkParams(['Operations', 'Finance'], 905),
        hq_locations: [loc(1205, 'Berlin', 'Germany', 'Europe', 52.52, 13.405)],
        last_updated: '2026-09-01T09:00:00+00:00', last_updated_utc: '2026-09-01 09:00:00', created_utc: '2020-06-15 12:00:00' },
      { id: '6', name: 'Dana Okafor', path: 'dana_okafor', tagline: 'CEO & Founder, Carewave', linkedin_url: 'https://www.linkedin.com/in/dana-okafor/', twitter_url: null, website_url: null,
        gender: 'female', is_founder: true, is_serial_founder: false, is_strong_founder: true, is_super_founder: true, is_promising_founder: false,
        founder_score: 93, founded_companies_total_funding: 47, backgrounds: mkParams(['Clinical', 'Product'], 906),
        hq_locations: [loc(1206, 'Boston', 'United States', 'North America', 42.3601, -71.0589)],
        last_updated: '2026-09-05T09:00:00+00:00', last_updated_utc: '2026-09-05 09:00:00', created_utc: '2019-09-20 12:00:00' },
      { id: '7', name: 'James Whitfield', path: 'james_whitfield', tagline: 'CFO, Carewave', linkedin_url: 'https://www.linkedin.com/in/james-whitfield/', twitter_url: null, website_url: null,
        gender: 'male', is_founder: false, is_serial_founder: false, is_strong_founder: false, is_super_founder: false, is_promising_founder: false,
        founder_score: 0, founded_companies_total_funding: 0, backgrounds: mkParams(['Finance'], 907),
        hq_locations: [loc(1207, 'Boston', 'United States', 'North America', 42.3601, -71.0589)],
        last_updated: '2026-09-05T09:00:00+00:00', last_updated_utc: '2026-09-05 09:00:00', created_utc: '2023-02-01 12:00:00' },
      { id: '8', name: 'Grace Liu', path: 'grace_liu', tagline: 'CEO & Founder, Curely', linkedin_url: 'https://www.linkedin.com/in/grace-liu/', twitter_url: null, website_url: null,
        gender: 'female', is_founder: true, is_serial_founder: false, is_strong_founder: false, is_super_founder: false, is_promising_founder: true,
        founder_score: 61, founded_companies_total_funding: 2.1, backgrounds: mkParams(['Clinical'], 908),
        hq_locations: [loc(1208, 'London', 'United Kingdom', 'Europe', 51.5072, -0.1276)],
        last_updated: '2026-08-15T09:00:00+00:00', last_updated_utc: '2026-08-15 09:00:00', created_utc: '2023-04-02 12:00:00' },
      { id: '9', name: 'Milo Petrov', path: 'milo_petrov', tagline: 'CEO & Founder, Pulsegrid', linkedin_url: 'https://www.linkedin.com/in/milo-petrov/', twitter_url: null, website_url: null,
        gender: 'male', is_founder: true, is_serial_founder: false, is_strong_founder: false, is_super_founder: false, is_promising_founder: false,
        founder_score: 52, founded_companies_total_funding: 1.5, backgrounds: mkParams(['Data Science'], 909),
        hq_locations: [loc(1209, 'Munich', 'Germany', 'Europe', 48.1351, 11.582)],
        last_updated: '2026-06-10T09:00:00+00:00', last_updated_utc: '2026-06-10 09:00:00', created_utc: '2023-02-01 12:00:00' },
      { id: '10', name: 'Ana Souza', path: 'ana_souza', tagline: 'CEO & Co-Founder, Codeforge', linkedin_url: 'https://www.linkedin.com/in/ana-souza/', twitter_url: null, website_url: null,
        gender: 'female', is_founder: true, is_serial_founder: false, is_strong_founder: true, is_super_founder: false, is_promising_founder: false,
        founder_score: 76, founded_companies_total_funding: 10, backgrounds: mkParams(['Engineering'], 910),
        hq_locations: [loc(1210, 'Austin', 'United States', 'North America', 30.2672, -97.7431)],
        last_updated: '2026-08-25T09:00:00+00:00', last_updated_utc: '2026-08-25 09:00:00', created_utc: '2021-05-18 12:00:00' },
      { id: '11', name: 'Ben Harcourt', path: 'ben_harcourt', tagline: 'CTO & Co-Founder, Codeforge · Venture Partner, Ferrovia Partners', linkedin_url: 'https://www.linkedin.com/in/ben-harcourt/', twitter_url: null, website_url: null,
        gender: 'male', is_founder: true, is_serial_founder: false, is_strong_founder: true, is_super_founder: false, is_promising_founder: false,
        founder_score: 72, founded_companies_total_funding: 10, backgrounds: mkParams(['Engineering'], 911),
        hq_locations: [loc(1211, 'Austin', 'United States', 'North America', 30.2672, -97.7431)],
        last_updated: '2026-08-25T09:00:00+00:00', last_updated_utc: '2026-08-25 09:00:00', created_utc: '2021-05-18 12:00:00' },
      { id: '12', name: 'Nora Vance', path: 'nora_vance', tagline: 'CEO & Founder, Devsloop', linkedin_url: 'https://www.linkedin.com/in/nora-vance/', twitter_url: null, website_url: null,
        gender: 'female', is_founder: true, is_serial_founder: false, is_strong_founder: false, is_super_founder: false, is_promising_founder: true,
        founder_score: 58, founded_companies_total_funding: 2, backgrounds: mkParams(['Engineering', 'DevOps'], 912),
        hq_locations: [loc(1212, 'Berlin', 'Germany', 'Europe', 52.52, 13.405)],
        last_updated: '2026-09-02T09:00:00+00:00', last_updated_utc: '2026-09-02 09:00:00', created_utc: '2024-01-08 12:00:00' },
    ];
    for (const p of people) store.create('dealroom', 'person', p, p.id);

    const membership = (
      id: string, orgType: 'company' | 'investor', orgId: string, personId: string, titleId: number, titleName: string,
      opts: { founder?: boolean; executive?: boolean; partner?: boolean; start: number; end?: number | null },
    ) => ({
      id, orgType, orgId, personId, titles: [param(titleId, titleName)], past: false,
      is_founder: opts.founder ?? false, is_executive: opts.executive ?? false, is_partner: opts.partner ?? false,
      year_start: opts.start, year_end: opts.end ?? null,
    });
    function param(id: number, name: string) {
      return { id, name };
    }

    const teamMemberships = [
      membership('tm_1', 'company', '1', '1', 1301, 'Chief Executive Officer', { founder: true, executive: true, start: 2022 }),
      membership('tm_2', 'company', '1', '2', 1302, 'Chief Technology Officer', { founder: true, executive: true, start: 2022 }),
      membership('tm_3', 'company', '2', '3', 1303, 'Chief Executive Officer', { founder: true, executive: true, start: 2023 }),
      membership('tm_4', 'company', '3', '4', 1304, 'Chief Executive Officer', { founder: true, executive: true, start: 2020 }),
      membership('tm_5', 'company', '3', '5', 1305, 'Chief Operating Officer', { founder: true, executive: true, start: 2020 }),
      membership('tm_6', 'company', '4', '6', 1306, 'Chief Executive Officer', { founder: true, executive: true, start: 2019 }),
      membership('tm_7', 'company', '4', '7', 1307, 'Chief Financial Officer', { executive: true, start: 2023 }),
      membership('tm_8', 'company', '5', '8', 1308, 'Chief Executive Officer', { founder: true, executive: true, start: 2023 }),
      membership('tm_9', 'company', '6', '9', 1309, 'Chief Executive Officer', { founder: true, executive: true, start: 2023 }),
      membership('tm_10', 'company', '7', '10', 1310, 'Chief Executive Officer', { founder: true, executive: true, start: 2021 }),
      membership('tm_11', 'company', '7', '11', 1311, 'Chief Technology Officer', { founder: true, executive: true, start: 2021 }),
      membership('tm_12', 'company', '8', '12', 1312, 'Chief Executive Officer', { founder: true, executive: true, start: 2024 }),
      membership('tm_13', 'investor', '1', '2', 1313, 'Venture Partner', { partner: true, start: 2025 }),
      membership('tm_14', 'investor', '2', '5', 1314, 'Venture Partner', { partner: true, start: 2025 }),
      membership('tm_15', 'investor', '3', '11', 1315, 'Venture Partner', { partner: true, start: 2025 }),
    ];
    for (const tm of teamMemberships) store.create('dealroom', 'team_membership', tm, tm.id);

    const round = (
      id: string, companyId: string, roundLabel: string, std: string, date: string,
      amount: number | null, currency: string, valuation: number | null, verified: boolean, undisclosed: boolean,
      eur: number | null, usd: number | null, createdUtc: string,
    ) => ({
      id, companyId, date, year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)),
      amount, amount_source: amount == null ? null : Math.round(amount * 1_000_000), currency,
      round: roundLabel, standardised_round_label: std, valuation, is_verified: verified, is_undisclosed: undisclosed,
      news_source: null, unknown_investors: [], amount_eur_million: eur, amount_usd_million: usd,
      last_updated: `${createdUtc.replace(' ', 'T')}+00:00`, last_updated_utc: createdUtc, created_utc: createdUtc,
    });

    const rounds = [
      round('1', '1', 'seed', 'Seed', '2023-10-12', 2.5, 'USD', 12, true, false, 2.3, 2.5, '2023-10-15 09:00:00'),
      round('2', '1', 'series a', 'Series A', '2025-02-20', 14, 'USD', 70, true, false, 12.88, 14, '2025-02-22 10:00:00'),
      round('3', '2', 'seed', 'Seed', '2023-12-05', 1.8, 'GBP', 9, true, false, 2.09, 2.29, '2023-12-07 09:30:00'),
      round('4', '2', 'series a', 'Series A', '2026-07-02', 9, 'GBP', 45, true, false, 10.44, 11.43, '2026-07-04 11:00:00'),
      round('5', '3', 'series a', 'Series A', '2023-05-09', 11, 'EUR', 55, true, false, 11, 11.99, '2023-05-11 08:45:00'),
      round('6', '3', 'series b', 'Series B', '2024-04-22', 28, 'EUR', 140, true, false, 28, 30.52, '2024-04-24 09:15:00'),
      round('7', '4', 'series a', 'Series A', '2023-08-14', 15, 'USD', 60, true, false, 13.8, 15, '2023-08-16 10:20:00'),
      round('8', '4', 'series b', 'Series B', '2024-11-03', 32, 'USD', 180, true, false, 29.44, 32, '2024-11-05 09:00:00'),
      round('9', '5', 'seed', 'Seed', '2024-02-27', 2.1, 'GBP', 10, true, false, 2.44, 2.67, '2024-03-01 09:40:00'),
      // Undisclosed — amount/valuation/currency conversions null on purpose,
      // to exercise the nullable-amount path the adapter must tolerate.
      round('10', '6', 'seed', 'Seed', '2023-09-19', null, 'EUR', null, false, true, null, null, '2023-09-21 10:05:00'),
      round('11', '7', 'series a', 'Series A', '2025-05-08', 10, 'USD', 55, true, false, 9.2, 10, '2025-05-10 09:50:00'),
      round('12', '8', 'seed', 'Seed', '2026-08-30', 2, 'EUR', 9, true, false, 2, 2.18, '2026-08-30 12:00:00'),
    ];
    for (const rnd of rounds) store.create('dealroom', 'round', rnd, rnd.id);

    const roundInvestors: { id: string; roundId: string; investorId: string; lead: boolean }[] = [
      { id: 'ri_1', roundId: '1', investorId: '2', lead: true }, { id: 'ri_2', roundId: '1', investorId: '5', lead: false },
      { id: 'ri_3', roundId: '2', investorId: '1', lead: true }, { id: 'ri_4', roundId: '2', investorId: '2', lead: false },
      { id: 'ri_5', roundId: '3', investorId: '2', lead: true },
      { id: 'ri_6', roundId: '4', investorId: '3', lead: true }, { id: 'ri_7', roundId: '4', investorId: '2', lead: false }, { id: 'ri_8', roundId: '4', investorId: '4', lead: false },
      { id: 'ri_9', roundId: '5', investorId: '3', lead: true },
      { id: 'ri_10', roundId: '6', investorId: '3', lead: true }, { id: 'ri_11', roundId: '6', investorId: '1', lead: false },
      { id: 'ri_12', roundId: '7', investorId: '1', lead: true }, { id: 'ri_13', roundId: '7', investorId: '5', lead: false },
      { id: 'ri_14', roundId: '8', investorId: '6', lead: true }, { id: 'ri_15', roundId: '8', investorId: '1', lead: false },
      { id: 'ri_16', roundId: '9', investorId: '2', lead: true }, { id: 'ri_17', roundId: '9', investorId: '4', lead: false },
      { id: 'ri_18', roundId: '10', investorId: '3', lead: true },
      { id: 'ri_19', roundId: '11', investorId: '1', lead: true }, { id: 'ri_20', roundId: '11', investorId: '2', lead: false },
      { id: 'ri_21', roundId: '12', investorId: '3', lead: true }, { id: 'ri_22', roundId: '12', investorId: '4', lead: false },
    ];
    for (const ri of roundInvestors) store.create('dealroom', 'round_investor', ri, ri.id);

    // Per-company investor roster (lead = led at least one of that company's
    // rounds; exited is a standalone fact, not derivable from round history —
    // one row set true to prove the field is wired).
    const companyInvestors: { id: string; companyId: string; investorId: string; lead: boolean; exited: boolean }[] = [
      { id: 'ci_1', companyId: '1', investorId: '1', lead: true, exited: false },
      { id: 'ci_2', companyId: '1', investorId: '2', lead: true, exited: false },
      { id: 'ci_3', companyId: '1', investorId: '5', lead: false, exited: true },
      { id: 'ci_4', companyId: '2', investorId: '2', lead: true, exited: false },
      { id: 'ci_5', companyId: '2', investorId: '3', lead: true, exited: false },
      { id: 'ci_6', companyId: '2', investorId: '4', lead: false, exited: false },
      { id: 'ci_7', companyId: '3', investorId: '3', lead: true, exited: false },
      { id: 'ci_8', companyId: '3', investorId: '1', lead: false, exited: false },
      { id: 'ci_9', companyId: '4', investorId: '1', lead: true, exited: false },
      { id: 'ci_10', companyId: '4', investorId: '5', lead: false, exited: false },
      { id: 'ci_11', companyId: '4', investorId: '6', lead: true, exited: false },
      { id: 'ci_12', companyId: '5', investorId: '2', lead: true, exited: false },
      { id: 'ci_13', companyId: '5', investorId: '4', lead: false, exited: false },
      { id: 'ci_14', companyId: '6', investorId: '3', lead: true, exited: false },
      { id: 'ci_15', companyId: '7', investorId: '1', lead: true, exited: false },
      { id: 'ci_16', companyId: '7', investorId: '2', lead: false, exited: false },
      { id: 'ci_17', companyId: '8', investorId: '3', lead: true, exited: false },
      { id: 'ci_18', companyId: '8', investorId: '4', lead: false, exited: false },
    ];
    for (const ci of companyInvestors) store.create('dealroom', 'company_investor', ci, ci.id);

    const funds = [
      { id: '1', investorId: '1', fund_name: 'Northbridge Fund II', fund_type: 'Venture Capital', amount: 150000000, currency: 'USD', is_closed: true, date: '2022-01-15T00:00:00+00:00', date_utc: '2022-01-15 00:00:00' },
      { id: '2', investorId: '1', fund_name: 'Northbridge Fund III', fund_type: 'Venture Capital', amount: 220000000, currency: 'USD', is_closed: false, date: '2025-03-01T00:00:00+00:00', date_utc: '2025-03-01 00:00:00' },
      { id: '3', investorId: '2', fund_name: 'Solstice Growth Fund I', fund_type: 'Venture Capital', amount: 90000000, currency: 'GBP', is_closed: true, date: '2021-11-10T00:00:00+00:00', date_utc: '2021-11-10 00:00:00' },
      { id: '4', investorId: '3', fund_name: 'Ferrovia Fund I', fund_type: 'Venture Capital', amount: 120000000, currency: 'EUR', is_closed: true, date: '2020-06-01T00:00:00+00:00', date_utc: '2020-06-01 00:00:00' },
      { id: '5', investorId: '6', fund_name: 'Atlas Ventures Fund', fund_type: 'Corporate', amount: 60000000, currency: 'USD', is_closed: false, date: '2023-09-01T00:00:00+00:00', date_utc: '2023-09-01 00:00:00' },
    ];
    for (const f of funds) store.create('dealroom', 'fund', f, f.id);

    console.log('  Seeded dealroom: 8 companies, 6 investors, 12 people, 12 rounds, 22 round-investor rows, 18 company-investor rows, 15 team memberships, 5 funds');
  }
}
