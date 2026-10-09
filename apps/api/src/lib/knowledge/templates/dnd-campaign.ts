import type { OntologyTemplate } from './types';

import PropertyValueType from '../../../generated/kysely/knowledge/PropertyValueType';
import EvaluationStrategy from '../../../generated/kysely/knowledge/EvaluationStrategy';
import { prop, fuzzy, exact, edge } from './types';

const dndCampaign: OntologyTemplate = {
  key: 'dnd-campaign',
  name: 'D&D Campaign',
  description:
    'Track characters, factions, locations, items, quests, relationships, and events across a tabletop RPG campaign',
  preview: ['Character', 'Faction', 'Location', 'Quest', 'Event'],

  nodeTypes: [
    // ── Message types ──

    {
      key: 'session_note',
      name: 'Session Note',
      description:
        'Notes from a single session — free-form recap, bullet points, or DM log describing what happened',
      category: 'message',
      properties: [],
    },
    {
      key: 'world_brief',
      name: 'World Brief',
      description:
        'Background lore, setting documents, or world-building notes — factions, history, geography, cosmology',
      category: 'message',
      properties: [],
    },

    // ── Object types (globally unique) ──

    {
      key: 'character',
      name: 'Character',
      description:
        'A player character, NPC, deity, or notable creature. Resolved globally by name',
      category: 'object',
      unique: [[fuzzy(prop('char_name'))]],
      properties: [
        {
          key: 'char_name',
          name: 'Name',
          description: "The character's name as commonly used",
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'char_race',
          name: 'Race',
          description: 'Race or species — Human, Elf, Tiefling, Dragonborn, etc.',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'char_class',
          name: 'Class',
          description: "Character class — Fighter, Wizard, Rogue, etc. Use 'NPC' for non-player characters without a class",
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'char_description',
          name: 'Description',
          description: 'Appearance, personality, mannerisms, and notable traits. Builds up over time from multiple mentions',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
        {
          key: 'char_status',
          name: 'Status',
          description: 'Current status — alive, dead, missing, imprisoned, petrified, transformed, etc.',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'char_motivation',
          name: 'Motivation',
          description: 'What drives this character — goals, fears, desires, secrets. Synthesized from observed behavior across sessions',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
      ],
    },
    {
      key: 'faction',
      name: 'Faction',
      description:
        'An organization, guild, cult, kingdom, noble house, or aligned group. Resolved globally by name',
      category: 'object',
      unique: [[fuzzy(prop('faction_name'))]],
      properties: [
        {
          key: 'faction_name',
          name: 'Name',
          description: 'The name of the faction or organization',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'faction_description',
          name: 'Description',
          description: 'Purpose, structure, and notable characteristics of the faction. Builds from multiple mentions',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
        {
          key: 'faction_alignment',
          name: 'Alignment',
          description: 'General moral alignment or disposition — lawful, chaotic, benevolent, sinister, pragmatic, etc.',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },
    {
      key: 'location',
      name: 'Location',
      description:
        'A named place — city, dungeon, tavern, region, or plane of existence. Resolved globally by name',
      category: 'object',
      unique: [[fuzzy(prop('loc_name'))]],
      properties: [
        {
          key: 'loc_name',
          name: 'Name',
          description: 'The name of the location',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'loc_description',
          name: 'Description',
          description: 'What the location looks like — atmosphere, notable features, dangers. Builds over time',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
        {
          key: 'loc_type',
          name: 'Type',
          description: 'Kind of location — city, dungeon, tavern, wilderness, underwater, planar, etc.',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },
    {
      key: 'item',
      name: 'Item',
      description:
        'A notable item — weapon, artifact, potion, scroll, spellbook, or key object. Resolved globally by name',
      category: 'object',
      unique: [[fuzzy(prop('item_name'))]],
      properties: [
        {
          key: 'item_name',
          name: 'Name',
          description: 'The name of the item',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'item_description',
          name: 'Description',
          description: 'Appearance, magical properties, effects, lore, and history. Builds as more is learned',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
        {
          key: 'item_type',
          name: 'Type',
          description: 'Kind of item — weapon, armor, potion, artifact, scroll, key, tool, etc.',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },
    {
      key: 'quest',
      name: 'Quest',
      description:
        'A mission, objective, or story arc. Resolved globally by name — tracks long-running goals across sessions',
      category: 'object',
      unique: [[fuzzy(prop('quest_name'))]],
      properties: [
        {
          key: 'quest_name',
          name: 'Name',
          description: 'Short name for the quest or story arc',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'quest_status',
          name: 'Status',
          description: 'Current status — active, completed, failed, abandoned, unknown',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'quest_description',
          name: 'Description',
          description: 'What needs to be done, stakes, complications. Synthesized from session progression',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
      ],
    },

    // ── Scoped objects (unique by name + edge) ──

    {
      key: 'event',
      name: 'Event',
      description:
        'A significant occurrence at a location — a battle, ritual, discovery, betrayal, or diplomatic meeting. Scoped to where it happened',
      category: 'object',
      unique: [[fuzzy(prop('event_name')), exact(edge('event_at_location', 'outgoing'))]],
      displayNameTemplate: '{Name} at {At Location}',
      properties: [
        {
          key: 'event_name',
          name: 'Name',
          description: 'Short name or label for the event — "Battle of Thornhaven", "The Betrayal at Driftmarket"',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'event_description',
          name: 'Description',
          description: 'What happened, who was involved, and the outcome. Synthesized across mentions',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
        {
          key: 'event_outcome',
          name: 'Outcome',
          description: 'How the event resolved — victory, defeat, truce, escape, revelation, etc.',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },
  ],

  edgeTypes: [
    // ── Session Note → objects (what appeared in this session) ──

    {
      key: 'session_features_character',
      outboundName: 'Features Character',
      inboundName: 'Featured In Sessions',
      description: 'A character that appears, acts, or is meaningfully referenced in this session',
      source: 'session_note',
      target: 'character',
      required: false,
    },
    {
      key: 'session_visits_location',
      outboundName: 'Visits Location',
      inboundName: 'Visited In Sessions',
      description: 'A location visited, explored, or meaningfully referenced in this session',
      source: 'session_note',
      target: 'location',
      required: false,
    },
    {
      key: 'session_involves_item',
      outboundName: 'Involves Item',
      inboundName: 'Involved In Sessions',
      description: 'An item found, used, traded, or meaningfully referenced in this session',
      source: 'session_note',
      target: 'item',
      required: false,
    },
    {
      key: 'session_advances_quest',
      outboundName: 'Advances Quest',
      inboundName: 'Advanced In Sessions',
      description: 'A quest that was started, advanced, completed, or failed during this session',
      source: 'session_note',
      target: 'quest',
      required: false,
    },

    // ── World Brief → objects (background lore populates the world) ──

    {
      key: 'brief_describes_character',
      outboundName: 'Describes Character',
      inboundName: 'Described In Briefs',
      description: 'A character described or introduced in this world brief',
      source: 'world_brief',
      target: 'character',
      required: false,
    },
    {
      key: 'brief_describes_faction',
      outboundName: 'Describes Faction',
      inboundName: 'Described In Briefs',
      description: 'A faction described in this world brief',
      source: 'world_brief',
      target: 'faction',
      required: false,
    },
    {
      key: 'brief_describes_location',
      outboundName: 'Describes Location',
      inboundName: 'Described In Briefs',
      description: 'A location described in this world brief',
      source: 'world_brief',
      target: 'location',
      required: false,
    },
    {
      key: 'brief_describes_item',
      outboundName: 'Describes Item',
      inboundName: 'Described In Briefs',
      description: 'An item described in this world brief',
      source: 'world_brief',
      target: 'item',
      required: false,
    },

    // ── Location → Location (containment) ──

    {
      key: 'loc_within_location',
      outboundName: 'Within',
      inboundName: 'Contains',
      description: 'This location is contained within or part of a larger location — a tavern within a city, a room within a dungeon',
      source: 'location',
      target: 'location',
      required: false,
    },

    // ── Character → Location (presence/association) ──

    {
      key: 'character_at_location',
      outboundName: 'At Location',
      inboundName: 'Characters Present',
      description: 'A character who resides at, operates from, or is strongly associated with this location',
      source: 'character',
      target: 'location',
      required: false,
    },

    // ── Item → Character (possession) ──

    {
      key: 'item_held_by',
      outboundName: 'Held By',
      inboundName: 'Holds Item',
      description: 'The character who currently possesses or carries this item',
      source: 'item',
      target: 'character',
      required: false,
    },

    // ── Quest → objects (quest connections) ──

    {
      key: 'quest_given_by',
      outboundName: 'Given By',
      inboundName: 'Quests Given',
      description: 'The character who gave or initiated this quest',
      source: 'quest',
      target: 'character',
      required: false,
    },
    {
      key: 'quest_targets_location',
      outboundName: 'Targets Location',
      inboundName: 'Targeted By Quests',
      description: 'A location that is the destination or objective of this quest',
      source: 'quest',
      target: 'location',
      required: false,
    },
    {
      key: 'quest_targets_item',
      outboundName: 'Targets Item',
      inboundName: 'Targeted By Quests',
      description: 'An item that is the objective of this quest — retrieve, destroy, deliver',
      source: 'quest',
      target: 'item',
      required: false,
    },
    {
      key: 'quest_targets_character',
      outboundName: 'Targets Character',
      inboundName: 'Targeted By Quests',
      description: 'A character who is the objective of this quest — rescue, assassinate, find, protect',
      source: 'quest',
      target: 'character',
      required: false,
    },
    {
      key: 'quest_involves_faction',
      outboundName: 'Involves Faction',
      inboundName: 'Involved In Quests',
      description: 'A faction connected to this quest — the quest giver faction, opposing faction, or faction whose interests are at stake',
      source: 'quest',
      target: 'faction',
      required: false,
    },

    // ── Faction → Location (control/presence) ──

    {
      key: 'faction_controls_location',
      outboundName: 'Controls',
      inboundName: 'Controlled By',
      description: 'The faction controls, occupies, or is headquartered at this location',
      source: 'faction',
      target: 'location',
      required: false,
    },

    // ── Faction → Faction (inter-faction relations) ──

    {
      key: 'faction_allied_with',
      outboundName: 'Allied With',
      inboundName: 'Allied With',
      description: 'This faction has an alliance or cooperative relationship with another faction',
      source: 'faction',
      target: 'faction',
      required: false,
    },
    {
      key: 'faction_hostile_to',
      outboundName: 'Hostile To',
      inboundName: 'Hostile To',
      description: 'This faction is hostile to, at war with, or actively opposing another faction',
      source: 'faction',
      target: 'faction',
      required: false,
    },

    // ── Character → Faction (membership with edge properties) ──

    {
      key: 'member_of_faction',
      outboundName: 'Member Of',
      inboundName: 'Members',
      description: 'This character is a member, agent, leader, or associate of this faction',
      source: 'character',
      target: 'faction',
      required: false,
      properties: [
        {
          key: 'membership_role',
          name: 'Role',
          description: "The character's role within the faction — leader, agent, ally, prisoner, spy, recruit, etc.",
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'membership_status',
          name: 'Status',
          description: 'Membership status — active, former, secret, expelled, deceased',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },

    // ── Event (significant occurrence at a location) ──

    {
      key: 'event_at_location',
      outboundName: 'At Location',
      inboundName: 'Events',
      description: 'The location where this event took place',
      source: 'event',
      target: 'location',
      required: true,
    },
    {
      key: 'session_has_event',
      outboundName: 'Has Event',
      inboundName: 'In Sessions',
      description: 'An event that occurred during this session',
      source: 'session_note',
      target: 'event',
      required: false,
    },
    {
      key: 'event_involves_character',
      outboundName: 'Involves Character',
      inboundName: 'Involved In Events',
      description: 'A character who participated in or was affected by this event',
      source: 'event',
      target: 'character',
      required: false,
    },
    {
      key: 'event_involves_faction',
      outboundName: 'Involves Faction',
      inboundName: 'Involved In Events',
      description: 'A faction involved in or affected by this event',
      source: 'event',
      target: 'faction',
      required: false,
    },

    // ── Character → Character (relationship with edge properties) ──

    {
      key: 'related_to',
      outboundName: 'Related To',
      inboundName: 'Related To',
      description: 'A directed relationship between two characters — rivalry, alliance, patron/client, romantic, familial, mentor/student',
      source: 'character',
      target: 'character',
      required: false,
      properties: [
        {
          key: 'rel_type',
          name: 'Type',
          description: 'Nature of the relationship — ally, rival, patron, servant, romantic, familial, hostile, mentor, debtor',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'rel_description',
          name: 'Description',
          description: 'Details of the relationship — history, current tensions, debts, secrets. Builds over time',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
        {
          key: 'rel_status',
          name: 'Status',
          description: 'Current state — active, strained, broken, secret, unknown to one party',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },
  ],

  extractionGraphs: [
    {
      key: 'session_extraction',
      name: 'Session Extraction',
      description: 'Extract characters, locations, items, factions, quests, events, and relationships from session notes',
      messageNodeType: 'session_note',
      children: [
        {
          edge: 'session_features_character', nodeType: 'character',
          children: [
            { edge: 'member_of_faction', nodeType: 'faction' },
            { edge: 'related_to', nodeType: 'character' },
            { edge: 'character_at_location', nodeType: 'location' },
          ],
        },
        {
          edge: 'session_visits_location', nodeType: 'location',
          children: [
            { edge: 'loc_within_location', nodeType: 'location' },
          ],
        },
        {
          edge: 'session_involves_item', nodeType: 'item',
          children: [
            { edge: 'item_held_by', nodeType: 'character' },
          ],
        },
        {
          edge: 'session_advances_quest', nodeType: 'quest',
          children: [
            { edge: 'quest_given_by', nodeType: 'character' },
            { edge: 'quest_targets_location', nodeType: 'location' },
            { edge: 'quest_targets_item', nodeType: 'item' },
            { edge: 'quest_targets_character', nodeType: 'character' },
            { edge: 'quest_involves_faction', nodeType: 'faction' },
          ],
        },
        {
          edge: 'session_has_event', nodeType: 'event',
          children: [
            { edge: 'event_at_location', nodeType: 'location' },
            { edge: 'event_involves_character', nodeType: 'character' },
            { edge: 'event_involves_faction', nodeType: 'faction' },
          ],
        },
      ],
    },
    {
      key: 'world_extraction',
      name: 'World Brief Extraction',
      description: 'Extract setting lore — factions, locations, characters, items, and their relationships from world-building documents',
      messageNodeType: 'world_brief',
      children: [
        {
          edge: 'brief_describes_character', nodeType: 'character',
          children: [
            { edge: 'member_of_faction', nodeType: 'faction' },
            { edge: 'related_to', nodeType: 'character' },
            { edge: 'character_at_location', nodeType: 'location' },
          ],
        },
        {
          edge: 'brief_describes_faction', nodeType: 'faction',
          children: [
            { edge: 'faction_controls_location', nodeType: 'location' },
            { edge: 'faction_allied_with', nodeType: 'faction' },
            { edge: 'faction_hostile_to', nodeType: 'faction' },
          ],
        },
        {
          edge: 'brief_describes_location', nodeType: 'location',
          children: [
            { edge: 'loc_within_location', nodeType: 'location' },
          ],
        },
        {
          edge: 'brief_describes_item', nodeType: 'item',
          children: [
            { edge: 'item_held_by', nodeType: 'character' },
          ],
        },
      ],
    },
  ],
};

export { dndCampaign };
