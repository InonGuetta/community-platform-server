// @ts-check
// A lesson's tags, beyond setting them with the lesson itself (that is the
// upload and the edit, in controllersMedia.js): the tag tree the archive
// filters by, a first guess from the title, a new tag proposed from the
// tagging dialog, and the tags the LLM proposed after processing (PRD ARCH-4).
// Every write here asks the same ownership question as tagging by hand.
import * as servicesMedia from "../services/servicesMedia.js";
import { assertCanManageMedia } from "../lib/permissions.js";
import { viewerScopeFor } from "../services/servicesVisibility.js";
import { requireIdList } from "../lib/validate.js";
import {
  getTagTree, proposeTag, getPendingProposalsForMedia, withdrawProposal,
} from "../services/servicesTags.js";
import { suggestTags } from "../lib/tagSuggestions.js";
import * as tagging from "../services/transcripts/tagging.js";
import { assertWithinAiBudget } from "../services/servicesAiUsage.js";

// Every tag in use, with how many items carry it. Feeds the upload form's
// autocomplete and the archive's filter — both of which need the same list, so
// it is one endpoint rather than two shapes of the same query.
export const getTags = async (req, res) => {
  // The counts are per VIEWER: a student must not be offered "7" beside a branch
  // that answers with three. Same scope object the listing resolves, so the
  // number on a chip and the rows behind it are decided by one rule.
  res.status(200).json(await getTagTree(await viewerScopeFor(req.user)));
};

// What this item looks like it is about, offered to whoever may tag it.
//
// A first guess from the title, never applied on its own — see
// lib/tagSuggestions.js for what it can and cannot know. It exists because the
// alternative, which this archive ran on until now, is that items arrive
// untagged and stay that way: every filter in the application was a control over
// an empty set, and asking again after the upload, with a starting point, is the
// cheapest moment to fix that.
//
// Ownership is checked, not just the role: a suggestion is about a particular
// item, and offering it discloses that item's title to whoever asked.
export const getTagSuggestions = async (req, res) => {
  const item = await servicesMedia.getMediaById(req.params.id);
  assertCanManageMedia(req.user, item);
  const tags = await getTagTree();
  res.status(200).json(suggestTags(item, tags));
};

// ── A new tag, proposed from an item's tagging dialog ───────────────────────
//
// The item is what the tag will be attached to once an admin approves it (an
// admin's own proposal is approved on the spot), so ownership is checked as for
// any other write to the item's tags.
export const proposeTagForMedia = async (req, res) => {
  assertCanManageMedia(req.user, await servicesMedia.getMediaById(req.params.id));
  const { name, parentId } = req.body ?? {};
  const result = await proposeTag({ mediaId: Number(req.params.id), name, parentId, user: req.user });
  // 201 either way — something was created: a proposal, or (for an admin) the tag.
  res.status(201).json(result);
};

export const getMediaTagProposals = async (req, res) => {
  assertCanManageMedia(req.user, await servicesMedia.getMediaById(req.params.id));
  res.status(200).json(await getPendingProposalsForMedia(req.params.id));
};

export const withdrawMediaTagProposal = async (req, res) => {
  assertCanManageMedia(req.user, await servicesMedia.getMediaById(req.params.id));
  await withdrawProposal(req.params.id, req.params.proposalId);
  res.status(204).end();
};

// ── Tags the LLM proposed (PRD ARCH-4) ──────────────────────────────────────
//
// Whoever may change this lesson's tags may see, ask for, accept and dismiss
// its proposals — the same ownership question as tagging it by hand.

const managedItem = async (req) => {
  const item = await servicesMedia.getMediaById(req.params.id);
  assertCanManageMedia(req.user, item);
  return item;
};

export const getAiTagSuggestions = async (req, res) => {
  await managedItem(req);
  res.status(200).json(await tagging.getAiTagSuggestions(req.params.id));
};

// Asking now, for a lesson processed before proposals existed or one whose
// tree has grown since. A person is waiting, and it is spend, so the monthly
// cap applies (PRD NFR-3).
export const requestAiTagSuggestions = async (req, res) => {
  await managedItem(req);
  await assertWithinAiBudget();
  res.status(200).json(await tagging.suggestTagsForMedia(req.params.id, { interactive: true }));
};

export const approveAiTagSuggestions = async (req, res) => {
  await managedItem(req);
  const tagIds = requireIdList(req.body?.tagIds, "tagIds");
  res.status(200).json(await tagging.approveAiTags(req.params.id, tagIds));
};

// Some (?tagId=…, repeatable) or all of them.
export const dismissAiTagSuggestions = async (req, res) => {
  await managedItem(req);
  const raw = req.query.tagId;
  const tagIds = raw === undefined ? null : requireIdList([].concat(raw), "tagId");
  res.status(200).json(await tagging.dismissAiTags(req.params.id, tagIds));
};
