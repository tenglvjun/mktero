// A highlight that crosses a PDF page becomes one Zotero annotation per page.
// Zotero has no field that ties them together, so a color change or a delete
// from the reader would reach only the page part the pointer was on. This
// module remembers which Zotero annotation keys were created as one highlight
// and applies those actions to all of them.
//
// The groups live in their own store, next to but separate from the local
// Markdown annotations, so an older Mktero that reads that file is unaffected.
// Only Zotero annotation keys are stored: no text, notes, or colors. A group
// is advisory. A failure to read or write it never blocks the action itself,
// which then falls back to the one annotation that was clicked.

import { isPDFAnnotationUnavailableError } from './pdf-annotation.js';

const MAX_GROUPS_PER_ITEM = 2_000;
// Matches the code the annotation store puts on an unreadable file.
const INVALID_STORE_ERROR_CODE = 'MARKDOWN_ANNOTATION_STORE_INVALID';
const MAX_MEMBERS_PER_GROUP = 64;
const ZOTERO_ANNOTATION_KEY = /^[A-Za-z0-9]{1,32}$/;

export class PDFAnnotationGroups {
    constructor({ store, onError = () => {} }) {
        if (!store?.get || !store?.put) {
            throw new TypeError('A PDF annotation group store is required');
        }
        this.store = store;
        this.onError = onError;
        this.operationTails = new Map();
    }

    // Records the parts of one highlight. A part already in another group
    // leaves that group: it now belongs to this highlight.
    record(itemID, annotationIDs) {
        const members = normalizeMembers(annotationIDs);
        if (members.length < 2) return Promise.resolve(false);
        return this.#safely(itemID, false, async () => {
            const groups = await this.#read(itemID);
            const memberSet = new Set(members);
            const kept = groups
                .map(group => group.filter(id => !memberSet.has(id)))
                .filter(group => group.length > 1);
            kept.push(members);
            while (kept.length > MAX_GROUPS_PER_ITEM) kept.shift();
            await this.store.put(itemID, kept);
            return true;
        });
    }

    // Every part of the highlight that contains the annotation, the annotation
    // itself first. An annotation in no group is its own only member.
    membersOf(itemID, annotationID) {
        const id = String(annotationID || '');
        return this.#safely(itemID, [id], async () => {
            const groups = await this.#read(itemID);
            const group = groups.find(candidate => candidate.includes(id));
            return group ? [id, ...group.filter(member => member !== id)] : [id];
        });
    }

    // Drops annotations that no longer exist. A group left with one member is
    // no longer a group.
    forget(itemID, annotationIDs) {
        const gone = new Set(normalizeMembers(annotationIDs));
        if (!gone.size) return Promise.resolve(false);
        return this.#safely(itemID, false, async () => {
            const groups = await this.#read(itemID);
            const kept = groups
                .map(group => group.filter(id => !gone.has(id)))
                .filter(group => group.length > 1);
            if (kept.length === groups.length
                && kept.every((group, index) => group.length === groups[index].length)) {
                return false;
            }
            await this.store.put(itemID, kept);
            return true;
        });
    }

    // Runs the action on the clicked annotation, then on the other parts of its
    // highlight. The clicked one decides success. Another part that fails is
    // skipped and reported; it leaves the group only when it no longer exists
    // (deleted in the Zotero reader, say), not when a save failed for now.
    // Resolves with the ids the action reached, clicked one first.
    async applyToGroup(itemID, annotationID, action, { forgetAfter = false } = {}) {
        const members = await this.membersOf(itemID, annotationID);
        const [primary, ...others] = members;
        await action(primary);
        const reached = [primary];
        const missing = [];
        for (const member of others) {
            try {
                await action(member);
                reached.push(member);
            }
            catch (error) {
                if (isPDFAnnotationUnavailableError(error)) missing.push(member);
                this.#report(error);
            }
        }
        if (forgetAfter) await this.forget(itemID, members);
        else if (missing.length) await this.forget(itemID, missing);
        return reached;
    }

    async #read(itemID) {
        let value;
        try {
            value = await this.store.get(itemID);
        }
        catch (error) {
            if (error?.code !== INVALID_STORE_ERROR_CODE) throw error;
            // An unreadable file would otherwise disable grouping for this
            // item for good. Keep it under a backup name and start over.
            this.#report(error);
            await this.store.setAside?.(itemID);
            return [];
        }
        if (!Array.isArray(value)) return [];
        return value
            .map(normalizeMembers)
            .filter(group => group.length > 1)
            .slice(-MAX_GROUPS_PER_ITEM);
    }

    async #safely(itemID, fallback, operation) {
        if (!Number.isInteger(itemID) || itemID <= 0) return fallback;
        const previous = this.operationTails.get(itemID) || Promise.resolve();
        const pending = previous.catch(() => {}).then(operation);
        this.operationTails.set(itemID, pending);
        try {
            return await pending;
        }
        catch (error) {
            this.#report(error);
            return fallback;
        }
        finally {
            if (this.operationTails.get(itemID) === pending) {
                this.operationTails.delete(itemID);
            }
        }
    }

    #report(error) {
        try {
            this.onError(error);
        }
        catch {
            // Group diagnostics must not make an annotation action fail.
        }
    }
}

function normalizeMembers(value) {
    if (!Array.isArray(value)) return [];
    const members = [];
    for (const entry of value) {
        const id = String(entry ?? '');
        if (!ZOTERO_ANNOTATION_KEY.test(id) || members.includes(id)) continue;
        members.push(id);
        if (members.length >= MAX_MEMBERS_PER_GROUP) break;
    }
    return members;
}
