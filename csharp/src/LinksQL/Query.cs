using System.Globalization;

namespace LinksQL;

/// <summary>
/// The human-friendly classification of a query's effect.
/// </summary>
public enum Operation
{
    /// <summary>A read-only query (restriction only).</summary>
    Read,

    /// <summary>An operation that only created links.</summary>
    Create,

    /// <summary>An operation that only updated links.</summary>
    Update,

    /// <summary>An operation that only deleted links.</summary>
    Delete,

    /// <summary>An operation that created/updated/deleted in more than one way.</summary>
    Mixed,

    /// <summary>An operation that changed nothing.</summary>
    Noop,
}

/// <summary>
/// One join row of a query report: the concrete links matched and the variable
/// bindings shared across them.
/// </summary>
/// <param name="Links">The concrete links matched, in pattern order.</param>
/// <param name="Binding">The variable bindings as <c>name -&gt; index</c>.</param>
public sealed record MatchRow(IReadOnlyList<Link> Links, IReadOnlyDictionary<string, long> Binding);

/// <summary>
/// A structured, immutable report of an executed query.
/// </summary>
/// <param name="Operation">The classified operation.</param>
/// <param name="Matched">The join rows that matched the restriction.</param>
/// <param name="Created">The links created by this operation.</param>
/// <param name="Updated">The links updated by this operation (final structure).</param>
/// <param name="Deleted">The links removed by this operation.</param>
public sealed record QueryReport(
    Operation Operation,
    IReadOnlyList<MatchRow> Matched,
    IReadOnlyList<Link> Created,
    IReadOnlyList<Link> Updated,
    IReadOnlyList<Link> Deleted);

/// <summary>
/// A single named reference, as surfaced by <see cref="Database.Introspect"/>.
/// </summary>
/// <param name="Name">The human-readable label.</param>
/// <param name="Index">The link index it is bound to.</param>
public sealed record NamedReference(string Name, long Index);

/// <summary>
/// The introspection snapshot of a database: its link count, named references,
/// and links.
/// </summary>
/// <param name="LinkCount">The number of stored links.</param>
/// <param name="Names">Every <c>(name, index)</c> association in the registry.</param>
/// <param name="Links">Every stored link.</param>
public sealed record IntrospectionReport(
    long LinkCount,
    IReadOnlyList<NamedReference> Names,
    IReadOnlyList<Link> Links);

/// <summary>
/// High-level query executor helpers and the public <see cref="Database"/>.
/// </summary>
/// <remarks>
/// A <see cref="Database"/> bundles a links store with a name registry and
/// exposes a single <see cref="Database.Query(string)"/> method that accepts
/// LiNo text. The text is parsed into a restriction and a substitution, the
/// operation runs, and a structured report describing what matched and what
/// changed comes back.
/// </remarks>
public static class Query
{
    /// <summary>
    /// Extract the pattern list from a restriction/substitution wrapper node.
    /// </summary>
    /// <param name="node">A top-level <see cref="LinkNode"/>.</param>
    /// <returns>The contained pattern nodes.</returns>
    /// <exception cref="QueryError">
    /// Thrown when the node is not a parenthesised list of patterns (a link with
    /// no identity).
    /// </exception>
    public static IReadOnlyList<Node> PatternsOf(Node node)
    {
        if (node is not LinkNode link || link.Id is not null)
        {
            throw new QueryError(
                "A restriction or substitution must be a parenthesised list of patterns");
        }

        return link.Values;
    }

    /// <summary>
    /// Split parsed LiNo nodes into a restriction and an (optional) substitution.
    /// </summary>
    /// <param name="nodes">Parsed top-level nodes.</param>
    /// <returns>
    /// The restriction patterns and the substitution patterns, or
    /// <see langword="null"/> substitution for a read.
    /// </returns>
    /// <exception cref="QueryError">
    /// Thrown when there are more than two top-level nodes.
    /// </exception>
    public static (IReadOnlyList<Node> Restriction, IReadOnlyList<Node>? Substitution) SplitQuery(
        IReadOnlyList<Node> nodes)
    {
        ArgumentNullException.ThrowIfNull(nodes);

        if (nodes.Count == 0)
        {
            return (Array.Empty<Node>(), null);
        }

        if (nodes.Count == 1)
        {
            return (PatternsOf(nodes[0]), null);
        }

        if (nodes.Count == 2)
        {
            return (PatternsOf(nodes[0]), PatternsOf(nodes[1]));
        }

        throw new QueryError(
            "A query must be \"(restriction)\" or \"(restriction) (substitution)\"");
    }

    /// <summary>
    /// Convert a stored link to its canonical LiNo node.
    /// </summary>
    /// <param name="link">A link.</param>
    /// <returns>A <see cref="LinkNode"/> of the form <c>(index: source target)</c>.</returns>
    public static LinkNode LinkToNode(Link link)
    {
        ArgumentNullException.ThrowIfNull(link);

        return new LinkNode(
            new NumberRef(link.Index),
            new Node[] { new NumberRef(link.Source), new NumberRef(link.Target) });
    }

    /// <summary>
    /// Serialise a link to canonical LiNo text, e.g. <c>(3: 1 2)</c>.
    /// </summary>
    /// <param name="link">A link.</param>
    /// <returns>LiNo text.</returns>
    public static string LinkToLino(Link link) => Lino.Serialize(LinkToNode(link));

    /// <summary>
    /// Classify a change report into a human-friendly operation name.
    /// </summary>
    /// <param name="result">The execution result.</param>
    /// <param name="readOnly">Whether the query was read-only.</param>
    /// <returns>The classified <see cref="Operation"/>.</returns>
    public static Operation Classify(ExecutionResult result, bool readOnly)
    {
        ArgumentNullException.ThrowIfNull(result);

        if (readOnly)
        {
            return Operation.Read;
        }

        var kinds = new List<Operation>(3);
        if (result.Created.Count > 0)
        {
            kinds.Add(Operation.Create);
        }

        if (result.Updated.Count > 0)
        {
            kinds.Add(Operation.Update);
        }

        if (result.Deleted.Count > 0)
        {
            kinds.Add(Operation.Delete);
        }

        if (kinds.Count == 0)
        {
            return Operation.Noop;
        }

        return kinds.Count == 1 ? kinds[0] : Operation.Mixed;
    }
}

/// <summary>
/// An associative database queried with the single substitution operation.
/// </summary>
public sealed class Database
{
    private readonly List<Action<QueryReport>> _listeners = new();

    /// <summary>Initializes a new instance of the <see cref="Database"/> class.</summary>
    /// <param name="autoCreate">Auto-create missing named references.</param>
    public Database(bool autoCreate = true)
    {
        Store = new LinksStore();
        Names = new Names(Store, autoCreate);
    }

    /// <summary>Gets the backing links store.</summary>
    public LinksStore Store { get; }

    /// <summary>Gets the name registry.</summary>
    public Names Names { get; }

    /// <summary>Gets the execution context passed to the engine.</summary>
    private SubstitutionContext Context => new(Store, Names);

    /// <summary>
    /// Register a change listener (used by the subscription layer).
    /// </summary>
    /// <param name="listener">Callback for each change.</param>
    /// <returns>An unsubscribe action.</returns>
    public Action OnChange(Action<QueryReport> listener)
    {
        ArgumentNullException.ThrowIfNull(listener);

        _listeners.Add(listener);
        return () => _listeners.Remove(listener);
    }

    /// <summary>
    /// Notify listeners about the changes produced by an operation.
    /// </summary>
    /// <param name="report">The structured query report.</param>
    public void Emit(QueryReport report)
    {
        ArgumentNullException.ThrowIfNull(report);

        if (report.Created.Count > 0 || report.Updated.Count > 0 || report.Deleted.Count > 0)
        {
            foreach (var listener in _listeners.ToArray())
            {
                listener(report);
            }
        }
    }

    /// <summary>
    /// Run a LinksQL query expressed as LiNo text.
    /// </summary>
    /// <param name="text">The query, e.g. <c>() ((1 1))</c>.</param>
    /// <returns>A structured query report.</returns>
    /// <exception cref="QueryError">
    /// Thrown when the text is not valid LiNo, not a valid query shape, or the
    /// substitution cannot be carried out.
    /// </exception>
    public QueryReport Query(string text)
    {
        IReadOnlyList<Node> nodes;
        try
        {
            nodes = Lino.Parse(text);
        }
        catch (LinoSyntaxError error)
        {
            throw new QueryError($"Invalid LiNo: {error.Message}", error);
        }

        var (restriction, substitution) = LinksQL.Query.SplitQuery(nodes);
        var readOnly = substitution is null;
        ExecutionResult raw;
        try
        {
            if (readOnly)
            {
                raw = new ExecutionResult();
                raw.MatchesList.AddRange(Substitution.Match(restriction, Context));
            }
            else
            {
                raw = Substitution.Execute(restriction, substitution!, Context);
            }
        }
        catch (SubstitutionError error)
        {
            throw new QueryError(error.Message, error);
        }

        var report = new QueryReport(
            LinksQL.Query.Classify(raw, readOnly),
            raw.Matches.Select(ToMatchRow).ToArray(),
            raw.Created.ToArray(),
            raw.Updated.ToArray(),
            raw.Deleted.ToArray());
        Emit(report);
        return report;
    }

    /// <summary>All stored links.</summary>
    /// <returns>Every stored link, in insertion order.</returns>
    public IReadOnlyList<Link> Links() => Store.All();

    /// <summary>Number of links currently stored.</summary>
    /// <returns>The link count.</returns>
    public int Count() => Store.Size;

    /// <summary>
    /// Serialise the whole database to canonical LiNo, one link per line.
    /// </summary>
    /// <returns>LiNo text.</returns>
    public string ToLino() =>
        string.Join("\n", Store.All().Select(LinksQL.Query.LinkToLino));

    /// <summary>
    /// Bulk-import links from LiNo text (each top-level link is created).
    /// </summary>
    /// <param name="text">LiNo text of <c>(index: source target)</c> links.</param>
    /// <returns>The number of links imported.</returns>
    public int ImportLino(string text)
    {
        var nodes = Lino.Parse(text);
        var count = 0;
        foreach (var node in nodes)
        {
            var report = Query(
                string.Create(CultureInfo.InvariantCulture, $"() ({Lino.Serialize(node)})"));
            count += report.Created.Count;
        }

        return count;
    }

    /// <summary>
    /// Describe the database for introspection tooling.
    /// </summary>
    /// <returns>Link count, named references and the links themselves.</returns>
    public IntrospectionReport Introspect() =>
        new(
            Store.Size,
            Names.Entries().Select(entry => new NamedReference(entry.Name, entry.Index)).ToArray(),
            Store.All());

    /// <summary>Remove every link and name.</summary>
    public void Clear()
    {
        Store.Clear();
        Names.Clear();
    }

    /// <summary>Project an engine <see cref="Row"/> into an immutable report row.</summary>
    private static MatchRow ToMatchRow(Row row) =>
        new(
            row.Links.ToArray(),
            new Dictionary<string, long>(row.Binding, StringComparer.Ordinal));
}
