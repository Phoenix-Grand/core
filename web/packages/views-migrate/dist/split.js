/**
 * The split pre-pass (`kbview-migrate --split`): a file exporting several screens (`ApiTokenForms.tsx` exporting
 * `NewTokenBanner` and `CreateTokenForm`) is cut into one file per exported component BEFORE the conversion, so each
 * becomes a view of its own (one `.kbview` per component - what the designer opens). A pure TSX refactor, nothing is
 * converted here:
 *
 * - every exported component other than the one named like the file moves to `<Component>.tsx` next to it, with the
 *   imports it uses (same specifiers: same folder);
 * - a top-level helper it uses (a constant, a function, a type) moves with it when nothing else of the file uses it,
 *   else it stays, exported, and the new file imports it;
 * - another component of the file it uses: imported from its new file (split too), or from the old one;
 * - the old file imports the component back when it still uses it; the project's importers of the component import
 *   it from its new file.
 */
import { basename } from 'node:path';
import { Node } from 'ts-morph';
import { componentsOf } from './migrate.js';
/** The top-level statement of `sf` declaring `node` (or undefined). */
function topStatement(sf, node) {
    let n = node;
    while (n && n.getParent() !== sf)
        n = n.getParent();
    return n;
}
function declaredNamesOf(st) {
    if (Node.isVariableStatement(st))
        return st.getDeclarations().map((d) => d.getName());
    if (Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st) || Node.isInterfaceDeclaration(st) || Node.isTypeAliasDeclaration(st) || Node.isEnumDeclaration(st)) {
        const n = st.getName();
        return n ? [n] : [];
    }
    return [];
}
function isExported(st) {
    return Node.isExportable(st) && st.isExported();
}
/**
 * What a statement refers to among the file's own top-level declarations and imports: names of top-level
 * statements, and import specifiers (by local name).
 */
function referencesOf(sf, st) {
    const statements = new Set();
    const imports = new Set();
    st.forEachDescendant((d) => {
        if (!Node.isIdentifier(d))
            return;
        const sym = d.getSymbol();
        for (const decl of sym?.getDeclarations() ?? []) {
            if (decl.getSourceFile() !== sf)
                continue;
            if (Node.isImportSpecifier(decl) || Node.isImportClause(decl) || Node.isNamespaceImport(decl)) {
                imports.add(d.getText());
                continue;
            }
            const top = topStatement(sf, decl);
            if (top && top !== st && !Node.isImportDeclaration(top))
                statements.add(top);
        }
    });
    return { statements, imports };
}
/** The import lines of `sf` restricted to the local names in `used` (specifiers rewritten by `spec`). */
function importLines(sf, used, spec = (s) => s) {
    const out = [];
    for (const imp of sf.getImportDeclarations()) {
        const named = imp.getNamedImports().filter((n) => used.has(n.getAliasNode()?.getText() ?? n.getName()));
        const def = imp.getDefaultImport();
        const ns = imp.getNamespaceImport();
        const parts = [];
        if (def && used.has(def.getText()))
            parts.push(def.getText());
        if (ns && used.has(ns.getText()))
            parts.push(`* as ${ns.getText()}`);
        if (named.length)
            parts.push(`{ ${named.map((n) => n.getText()).join(', ')} }`);
        if (parts.length)
            out.push(`import ${imp.isTypeOnly() ? 'type ' : ''}${parts.join(', ')} from ${JSON.stringify(spec(imp.getModuleSpecifierValue()))}`);
    }
    return out;
}
/** Replaces the last path segment of a module specifier (`./ApiTokenForms` → `./NewTokenBanner`). */
function sibling(specifier, from, to) {
    const m = new RegExp(`(^|/)${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.tsx?)?$`).exec(specifier);
    if (!m)
        return undefined;
    return specifier.slice(0, m.index) + m[1] + to;
}
/** Adds an import line after the file's last import, as written (the project's style: single quotes, no semicolon). */
function addImport(sf, line) {
    const imports = sf.getImportDeclarations();
    const at = imports.length ? imports[imports.length - 1].getEnd() : 0;
    sf.insertText(at, imports.length ? `
${line}` : `${line}
`);
}
export function splitFile(cfg, sf) {
    const file = sf.getFilePath();
    const stem = basename(file).replace(/\.tsx?$/, '');
    const exported = componentsOf(sf).filter((c) => c.exportedAt);
    // One exported component is split out too when it is not the file's namesake and the file exports other things (a
    // re-export, a helper): the view is named after the component, the module keeps the rest.
    const otherExports = sf.getExportDeclarations().length > 0 || sf.getStatements().some((st) => isExported(st) && !exported.some((c) => topStatement(sf, c.fn) === st));
    if (exported.length === 0 || (exported.length === 1 && (exported[0].name === stem || !otherExports)))
        return undefined;
    const toMove = exported.filter((c) => c.name !== stem && c.exported === 'named');
    if (!toMove.length)
        return undefined;
    // ts-morph paths (forward slashes on every OS).
    const dir = file.slice(0, file.lastIndexOf('/'));
    const movedNames = new Set(toMove.map((c) => c.name));
    // The project's files importing this one, with the specifiers they use for it (read now: rewriting the file below
    // may change what its specifier resolves to).
    const importerSpecs = new Map();
    for (const other of cfg.project.getSourceFiles()) {
        for (const imp of other.getImportDeclarations()) {
            if (imp.getModuleSpecifierSourceFile() !== sf)
                continue;
            const set = importerSpecs.get(other.getFilePath()) ?? new Set();
            set.add(imp.getModuleSpecifierValue());
            importerSpecs.set(other.getFilePath(), set);
        }
    }
    const stmtOf = new Map(toMove.map((c) => [c.name, topStatement(sf, c.fn)]));
    const created = {};
    const edits = {};
    const result = { file, created, edits, deleted: [], moved: [] };
    // Who uses what: every top-level statement's references, to know which helpers only one moved component uses.
    const allStatements = sf.getStatements().filter((s) => !Node.isImportDeclaration(s));
    const refs = new Map(allStatements.map((s) => [s, referencesOf(sf, s)]));
    const usersOf = (st) => allStatements.filter((s) => s !== st && refs.get(s).statements.has(st));
    // A helper moves with a component when every statement using it moves with that same component.
    const movedWith = new Map();
    // A local (unexported) component it renders that others render too is copied into its file: the old file's own
    // conversion moves its local components out of reach (into its parts file).
    const copiedWith = new Map();
    for (const c of toMove) {
        const own = stmtOf.get(c.name);
        const queue = [...refs.get(own).statements];
        while (queue.length) {
            const h = queue.shift();
            if (movedWith.has(h) || [...stmtOf.values()].includes(h))
                continue;
            const isComponent = componentsOf(sf).some((x) => topStatement(sf, x.fn) === h);
            if (isExported(h))
                continue;
            const users = usersOf(h);
            if (users.every((u) => u === own || movedWith.get(u) === c.name)) {
                movedWith.set(h, c.name);
                queue.push(...refs.get(h).statements);
            }
            else if (isComponent && !(copiedWith.get(c.name) ?? []).includes(h)) {
                copiedWith.set(c.name, [...(copiedWith.get(c.name) ?? []), h]);
                queue.push(...refs.get(h).statements);
            }
        }
    }
    const toExport = new Set();
    const texts = {};
    for (const c of toMove) {
        const own = stmtOf.get(c.name);
        const mine = allStatements.filter((s) => s === own || movedWith.get(s) === c.name || (copiedWith.get(c.name) ?? []).includes(s));
        const usedImports = new Set();
        const fromOld = new Set();
        const fromSplit = new Map();
        for (const s of mine) {
            const r = refs.get(s);
            for (const i of r.imports)
                usedImports.add(i);
            for (const t of r.statements) {
                if (mine.includes(t))
                    continue;
                const names = declaredNamesOf(t);
                const other = names.find((n) => movedNames.has(n));
                if (other)
                    fromSplit.set(other, other);
                else {
                    // A type is imported as one (`verbatimModuleSyntax`).
                    const typeOnly = Node.isInterfaceDeclaration(t) || Node.isTypeAliasDeclaration(t);
                    for (const n of names)
                        fromOld.add(typeOnly ? `type ${n}` : n);
                    if (!isExported(t))
                        toExport.add(t);
                }
            }
        }
        const lines = importLines(sf, usedImports);
        if (fromOld.size)
            lines.push(`import { ${[...fromOld].join(', ')} } from './${stem}'`);
        for (const n of fromSplit.keys())
            lines.push(`import { ${n} } from './${n}'`);
        const body = mine.map((s) => s.getFullText().replace(/^\s*\n/, '')).join('\n\n');
        texts[c.name] = `${lines.join('\n')}\n\n${body.trim()}\n`;
        result.moved.push({ component: c.name, file: `${dir}/${c.name}.tsx` });
    }
    // The old file: the moved statements out, the helpers they share exported, the moved components imported back.
    for (const st of toExport)
        if (Node.isExportable(st))
            st.setIsExported(true);
    const removed = allStatements.filter((s) => [...stmtOf.values()].includes(s) || movedWith.has(s));
    // A copied local component the old file itself no longer renders goes too (it would be left unused).
    const copied = new Set([...copiedWith.values()].flat());
    for (let again = true; again;) {
        again = false;
        for (const s of copied) {
            if (removed.includes(s) || isExported(s) || toExport.has(s))
                continue;
            if (usersOf(s).every((u) => removed.includes(u))) {
                removed.push(s);
                again = true;
            }
        }
    }
    const usedBack = new Set();
    for (const s of allStatements) {
        if (removed.includes(s))
            continue;
        for (const t of refs.get(s).statements)
            for (const n of declaredNamesOf(t))
                if (movedNames.has(n))
                    usedBack.add(n);
    }
    // Their leading comments go with them (ts-morph leaves a comment separated by a blank line behind).
    const comments = removed.flatMap((s) => s.getLeadingCommentRanges().map((r) => r.getText()));
    for (const s of removed)
        s.remove();
    let rest = sf.getFullText();
    for (const c of comments) {
        const at = rest.indexOf(c);
        if (at >= 0)
            rest = rest.slice(0, at) + rest.slice(at + c.length).replace(/^[ \t]*\r?\n/, '');
    }
    if (rest !== sf.getFullText())
        sf.replaceWithText(rest);
    // Imports nothing uses any more (again until none goes: a removal can leave a stale reference behind).
    for (let pass = 0, before = -1; pass < 3 && before !== sf.getFullText().length; pass++) {
        before = sf.getFullText().length;
        for (const imp of sf.getImportDeclarations()) {
            for (const n of imp.getNamedImports()) {
                const local = n.getAliasNode() ?? n.getNameNode();
                if (!Node.isIdentifier(local) || local.findReferencesAsNodes().every((r) => r.getSourceFile() !== sf || r === local))
                    n.remove();
            }
            const def = imp.getDefaultImport();
            if (def && def.findReferencesAsNodes().every((r) => r.getSourceFile() !== sf || r === def))
                imp.removeDefaultImport();
            if (!imp.getNamedImports().length && !imp.getDefaultImport() && !imp.getNamespaceImport() && imp.getImportClause())
                imp.remove();
        }
    }
    for (const n of usedBack)
        addImport(sf, `import { ${n} } from './${n}'`);
    // The project's importers of the moved components.
    for (const other of cfg.project.getSourceFiles()) {
        if (other === sf)
            continue;
        const lines = [];
        for (const imp of [...other.getImportDeclarations()]) {
            // Resolved before the old file was rewritten (emptied of its exports, it may no longer resolve as a module).
            if (!importerSpecs.get(other.getFilePath())?.has(imp.getModuleSpecifierValue()))
                continue;
            for (const n of imp.getNamedImports()) {
                if (!movedNames.has(n.getName()))
                    continue;
                const spec = sibling(imp.getModuleSpecifierValue(), stem, n.getName());
                if (!spec)
                    continue;
                lines.push(`import ${imp.isTypeOnly() ? 'type ' : ''}{ ${n.getText()} } from '${spec}'`);
                n.remove();
            }
            if (!imp.getNamedImports().length && !imp.getDefaultImport() && !imp.getNamespaceImport())
                imp.remove();
        }
        for (const line of lines)
            addImport(other, line);
        if (lines.length)
            edits[other.getFilePath()] = other.getFullText();
    }
    if (sf.getStatements().every((st) => Node.isImportDeclaration(st)))
        result.deleted.push(file);
    else
        edits[file] = sf.getFullText();
    for (const c of toMove)
        created[`${dir}/${c.name}.tsx`] = texts[c.name];
    return result;
}
