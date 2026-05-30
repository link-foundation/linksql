namespace LinksQL;

/// <summary>
/// The execution context passed to the substitution engine: the backing store
/// and an optional name registry.
/// </summary>
/// <param name="Store">The links store to read and mutate.</param>
/// <param name="Names">
/// The name registry, or <see langword="null"/> when named references are
/// disabled.
/// </param>
public sealed record SubstitutionContext(LinksStore Store, Names? Names);

/// <summary>
/// The three slots a link pattern decomposes into.
/// </summary>
/// <param name="Id">The identity slot, or <see langword="null"/> when absent.</param>
/// <param name="Source">The source slot, or <see langword="null"/> ("match anything").</param>
/// <param name="Target">The target slot, or <see langword="null"/> ("match anything").</param>
public readonly record struct LinkSlots(Node? Id, Node? Source, Node? Target);

/// <summary>
/// A single binding row produced by the restriction join: the concrete links
/// matched (in pattern order) and the variable bindings shared across the row.
/// </summary>
public sealed class Row
{
    /// <summary>Gets the variable bindings as <c>name -&gt; index</c>.</summary>
    /// <remarks>
    /// Mutable during the join (each pattern extends the binding in place);
    /// stable once the row is finalised.
    /// </remarks>
    public Dictionary<string, long> Binding { get; init; } = new(StringComparer.Ordinal);

    /// <summary>Gets the concrete links matched, in pattern order.</summary>
    public IReadOnlyList<Link> Links { get; init; } = Array.Empty<Link>();
}

/// <summary>
/// A report of everything an <see cref="Substitution.Execute"/> matched and
/// changed.
/// </summary>
/// <remarks>
/// The engine appends to the <c>internal</c> backing lists while running; the
/// public surface exposes only read-only views.
/// </remarks>
public sealed class ExecutionResult
{
    internal List<Row> MatchesList { get; } = new();

    internal List<Link> CreatedList { get; } = new();

    internal List<Link> UpdatedList { get; } = new();

    internal List<Link> DeletedList { get; } = new();

    /// <summary>Gets the join rows that matched the restriction.</summary>
    public IReadOnlyList<Row> Matches => MatchesList;

    /// <summary>Gets the links created by this operation.</summary>
    public IReadOnlyList<Link> Created => CreatedList;

    /// <summary>Gets the links updated by this operation (final structure).</summary>
    public IReadOnlyList<Link> Updated => UpdatedList;

    /// <summary>Gets the links removed by this operation.</summary>
    public IReadOnlyList<Link> Deleted => DeletedList;
}

/// <summary>
/// The single substitution operation and its matching primitives.
/// </summary>
/// <remarks>
/// LinksQL has exactly one operation. A query is a pair of pattern lists — a
/// <em>restriction</em> and a <em>substitution</em>. The restriction selects
/// existing links (binding variables along the way); the substitution describes
/// what those links become. The four CRUD behaviours are derived from how the
/// two lists line up positionally.
/// </remarks>
public static class Substitution
{
    /// <summary>
    /// Decompose a link pattern node into its three slots.
    /// </summary>
    /// <param name="node">A <see cref="LinkNode"/>.</param>
    /// <returns>The decomposed <see cref="LinkSlots"/>.</returns>
    /// <exception cref="SubstitutionError">
    /// Thrown when the node is not a link, or has an unsupported value count.
    /// </exception>
    public static LinkSlots GetLinkSlots(Node node)
    {
        if (node is not LinkNode link)
        {
            throw new SubstitutionError(
                "Each restriction/substitution pattern must be a link");
        }

        var values = link.Values;
        if (values.Count == 2)
        {
            return new LinkSlots(link.Id, values[0], values[1]);
        }

        if (values.Count == 0)
        {
            return new LinkSlots(link.Id, null, null);
        }

        if (values.Count == 1 && link.Id is null)
        {
            return new LinkSlots(values[0], null, null);
        }

        throw new SubstitutionError(
            $"A link pattern must have 0 or 2 values (got {values.Count})");
    }

    /// <summary>
    /// Resolve a value node to a concrete link index for <em>matching</em>
    /// purposes.
    /// </summary>
    /// <param name="node">Reference or nested link node.</param>
    /// <param name="binding">Current variable bindings.</param>
    /// <param name="ctx">Execution context.</param>
    /// <returns>The index, or <see langword="null"/> when it cannot resolve.</returns>
    private static long? ResolveForMatch(Node? node, Dictionary<string, long> binding, SubstitutionContext ctx)
    {
        switch (node)
        {
            case null:
                // Mirrors the JavaScript engine, which never reaches here with a
                // null slot in practice; treat "no node" as unresolved.
                return null;
            case NumberRef number:
                return number.Value;
            case NameRef name:
                return ctx.Names?.Resolve(name.Value);
            case VariableRef:
            case WildcardRef:
                // Variables and wildcards are handled by the caller.
                return null;
        }

        var slots = GetLinkSlots(node);
        var source = ResolveForMatch(slots.Source, binding, ctx);
        var target = ResolveForMatch(slots.Target, binding, ctx);
        if (source is null || target is null)
        {
            return null;
        }

        var found = ctx.Store.FindByPair(source.Value, target.Value);
        return found?.Index;
    }

    /// <summary>
    /// Constrain one slot of a pattern against an actual value, updating bindings.
    /// </summary>
    /// <param name="slot">The slot node (<see langword="null"/> means "match anything").</param>
    /// <param name="actual">The link's value at this slot.</param>
    /// <param name="binding">Mutable bindings for the current row.</param>
    /// <param name="ctx">Execution context.</param>
    /// <returns><see langword="true"/> when the slot is satisfied.</returns>
    public static bool MatchSlot(Node? slot, long actual, Dictionary<string, long> binding, SubstitutionContext ctx)
    {
        ArgumentNullException.ThrowIfNull(binding);
        ArgumentNullException.ThrowIfNull(ctx);

        switch (slot)
        {
            case null:
                return true;
            case WildcardRef:
                return true;
            case VariableRef variable:
                if (binding.TryGetValue(variable.Value, out var bound))
                {
                    return bound == actual;
                }

                binding[variable.Value] = actual;
                return true;
        }

        var expected = ResolveForMatch(slot, binding, ctx);
        return expected is not null && expected.Value == actual;
    }

    /// <summary>
    /// Test a single pattern against a single link, extending the binding in
    /// place.
    /// </summary>
    /// <param name="pattern">Link pattern node.</param>
    /// <param name="link">A stored link.</param>
    /// <param name="binding">Mutable bindings.</param>
    /// <param name="ctx">Execution context.</param>
    /// <returns><see langword="true"/> when the link matches the pattern.</returns>
    public static bool MatchOne(Node pattern, Link link, Dictionary<string, long> binding, SubstitutionContext ctx)
    {
        ArgumentNullException.ThrowIfNull(link);

        var slots = GetLinkSlots(pattern);
        return MatchSlot(slots.Id, link.Index, binding, ctx)
            && MatchSlot(slots.Source, link.Source, binding, ctx)
            && MatchSlot(slots.Target, link.Target, binding, ctx);
    }

    /// <summary>
    /// Join all restriction patterns into a set of binding rows.
    /// </summary>
    /// <param name="patterns">Restriction pattern nodes.</param>
    /// <param name="ctx">Execution context.</param>
    /// <param name="snapshot">The links to match against (pre-mutation).</param>
    /// <returns>The surviving binding rows.</returns>
    public static IReadOnlyList<Row> JoinRestriction(
        IReadOnlyList<Node> patterns,
        SubstitutionContext ctx,
        IReadOnlyList<Link> snapshot)
    {
        ArgumentNullException.ThrowIfNull(patterns);
        ArgumentNullException.ThrowIfNull(snapshot);

        var rows = new List<Row> { new() };
        foreach (var pattern in patterns)
        {
            var next = new List<Row>();
            foreach (var row in rows)
            {
                foreach (var link in snapshot)
                {
                    var binding = new Dictionary<string, long>(row.Binding, StringComparer.Ordinal);
                    if (MatchOne(pattern, link, binding, ctx))
                    {
                        var links = new List<Link>(row.Links) { link };
                        next.Add(new Row { Binding = binding, Links = links });
                    }
                }
            }

            rows = next;
        }

        return rows;
    }

    /// <summary>
    /// Match a restriction against the store without mutating anything (the read
    /// path).
    /// </summary>
    /// <param name="restriction">Restriction pattern nodes.</param>
    /// <param name="ctx">Execution context.</param>
    /// <returns>The binding rows.</returns>
    public static IReadOnlyList<Row> Match(IReadOnlyList<Node> restriction, SubstitutionContext ctx)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        return JoinRestriction(restriction, ctx, ctx.Store.All());
    }

    /// <summary>
    /// Test whether a single link satisfies at least one of the given patterns.
    /// </summary>
    /// <param name="patterns">Restriction pattern nodes.</param>
    /// <param name="link">A link.</param>
    /// <param name="ctx">Execution context.</param>
    /// <returns><see langword="true"/> when the link matches any pattern.</returns>
    public static bool LinkMatches(IReadOnlyList<Node> patterns, Link link, SubstitutionContext ctx)
    {
        ArgumentNullException.ThrowIfNull(patterns);

        if (patterns.Count == 0)
        {
            return true;
        }

        foreach (var pattern in patterns)
        {
            if (MatchOne(pattern, link, new Dictionary<string, long>(StringComparer.Ordinal), ctx))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Resolve a value node to a concrete index when <em>producing</em> output.
    /// Unlike matching, every reference must resolve.
    /// </summary>
    /// <param name="node">Reference or nested link node.</param>
    /// <param name="binding">Variable bindings for the row.</param>
    /// <param name="ctx">Execution context.</param>
    /// <param name="created">Accumulator for links created as a side effect.</param>
    /// <returns>The resolved index.</returns>
    /// <exception cref="SubstitutionError">
    /// Thrown for unbound variables, wildcards, unresolvable names, or malformed
    /// nested links.
    /// </exception>
    private static long ResolveForOutput(Node node, Dictionary<string, long> binding, SubstitutionContext ctx, ICollection<Link> created)
    {
        switch (node)
        {
            case NumberRef number:
                return number.Value;
            case VariableRef variable:
                if (!binding.TryGetValue(variable.Value, out var bound))
                {
                    throw new SubstitutionError(
                        $"Unbound variable ${variable.Value} in substitution");
                }

                return bound;
            case WildcardRef:
                throw new SubstitutionError("Wildcard * cannot appear in a substitution");
            case NameRef name:
                if (ctx.Names is null)
                {
                    throw new SubstitutionError(
                        $"Named reference \"{name.Value}\" requires names to be enabled");
                }

                return ctx.Names.Ensure(name.Value);
        }

        var slots = GetLinkSlots(node);
        if (slots.Source is null || slots.Target is null)
        {
            throw new SubstitutionError("Nested link must have a source and a target");
        }

        var source = ResolveForOutput(slots.Source, binding, ctx, created);
        var target = ResolveForOutput(slots.Target, binding, ctx, created);
        long? index = slots.Id is null ? null : ResolveForOutput(slots.Id, binding, ctx, created);
        var existing = ctx.Store.FindByPair(source, target);
        if (existing is not null)
        {
            return existing.Index;
        }

        var link = ctx.Store.Create(index, source, target);
        created.Add(link);
        return link.Index;
    }

    /// <summary>
    /// Turn a substitution pattern into a concrete <c>(index?, source, target)</c>
    /// spec.
    /// </summary>
    /// <param name="pattern">Substitution pattern node.</param>
    /// <param name="binding">Variable bindings for the row.</param>
    /// <param name="ctx">Execution context.</param>
    /// <param name="created">Accumulator for nested-link side effects.</param>
    /// <param name="matched">The link being rewritten (for an update), if any.</param>
    /// <returns>The materialised <c>(index, source, target)</c> specification.</returns>
    /// <exception cref="SubstitutionError">
    /// Thrown when a created link omits its source and target.
    /// </exception>
    public static (long? Index, long Source, long Target) Materialize(
        Node pattern,
        Dictionary<string, long> binding,
        SubstitutionContext ctx,
        ICollection<Link> created,
        Link? matched)
    {
        ArgumentNullException.ThrowIfNull(binding);
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(created);

        var slots = GetLinkSlots(pattern);
        long? index = slots.Id is null ? null : ResolveForOutput(slots.Id, binding, ctx, created);
        if (slots.Source is null || slots.Target is null)
        {
            if (matched is null)
            {
                throw new SubstitutionError(
                    "A created link must specify a source and a target");
            }

            return (index, matched.Source, matched.Target);
        }

        var source = ResolveForOutput(slots.Source, binding, ctx, created);
        var target = ResolveForOutput(slots.Target, binding, ctx, created);
        return (index, source, target);
    }

    /// <summary>
    /// Execute one substitution operation against the store.
    /// </summary>
    /// <param name="restriction">Restriction pattern nodes.</param>
    /// <param name="substitution">Substitution pattern nodes.</param>
    /// <param name="ctx">Execution context.</param>
    /// <returns>A report of everything that matched and changed.</returns>
    public static ExecutionResult Execute(
        IReadOnlyList<Node> restriction,
        IReadOnlyList<Node> substitution,
        SubstitutionContext ctx)
    {
        ArgumentNullException.ThrowIfNull(restriction);
        ArgumentNullException.ThrowIfNull(substitution);
        ArgumentNullException.ThrowIfNull(ctx);

        var snapshot = ctx.Store.All();
        var rows = JoinRestriction(restriction, ctx, snapshot);
        var result = new ExecutionResult();
        var paired = Math.Min(restriction.Count, substitution.Count);

        foreach (var row in rows)
        {
            result.MatchesList.Add(row);

            for (var i = 0; i < paired; i += 1)
            {
                var matched = row.Links[i];
                if (!ctx.Store.Has(matched.Index))
                {
                    continue; // already removed by an earlier row
                }

                var spec = Materialize(substitution[i], row.Binding, ctx, result.CreatedList, matched);
                result.UpdatedList.Add(
                    ctx.Store.Update(matched.Index, spec.Source, spec.Target, spec.Index));
            }

            for (var i = paired; i < restriction.Count; i += 1)
            {
                var matched = row.Links[i];
                if (ctx.Store.Delete(matched.Index))
                {
                    result.DeletedList.Add(matched);
                }
            }

            for (var i = paired; i < substitution.Count; i += 1)
            {
                var spec = Materialize(substitution[i], row.Binding, ctx, result.CreatedList, null);
                result.CreatedList.Add(ctx.Store.Create(spec.Index, spec.Source, spec.Target));
            }
        }

        return result;
    }
}
