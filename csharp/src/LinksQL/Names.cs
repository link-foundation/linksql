namespace LinksQL;

/// <summary>
/// A bidirectional registry of label &lt;-&gt; link-index associations.
/// </summary>
/// <remarks>
/// Link indices are convenient for machines but opaque to humans. A
/// <see cref="Names"/> registry maps human-readable labels to link identities so
/// a query can say <c>(alice loves bob)</c> instead of <c>(7 9 8)</c>. A freshly
/// named identity is materialised as a <em>point</em> — the link <c>(i: i i)</c>
/// — so that everything in the model remains a link. When
/// <see cref="AutoCreate"/> is disabled, referring to an unknown name is an
/// error instead.
/// </remarks>
public sealed class Names
{
    private readonly LinksStore _store;
    private readonly Dictionary<string, long> _byName = new(StringComparer.Ordinal);
    private readonly Dictionary<long, string> _byIndex = new();
    private readonly List<string> _order = new();

    /// <summary>Initializes a new instance of the <see cref="Names"/> class.</summary>
    /// <param name="store">Backing links store.</param>
    /// <param name="autoCreate">Allocate missing names on demand.</param>
    public Names(LinksStore store, bool autoCreate = true)
    {
        _store = store;
        AutoCreate = autoCreate;
    }

    /// <summary>Gets a value indicating whether missing names are allocated on demand.</summary>
    public bool AutoCreate { get; }

    /// <summary>
    /// Resolve a name to its index without creating anything.
    /// </summary>
    /// <param name="name">The label to look up.</param>
    /// <returns>The index, or <see langword="null"/> when unknown.</returns>
    public long? Resolve(string name) =>
        _byName.TryGetValue(name, out var index) ? index : null;

    /// <summary>
    /// Resolve a name, allocating and materialising it when permitted.
    /// </summary>
    /// <param name="name">The label to ensure.</param>
    /// <returns>The associated index.</returns>
    /// <exception cref="UnknownNameError">
    /// Thrown when the name is unknown and auto-creation is disabled.
    /// </exception>
    public long Ensure(string name)
    {
        if (_byName.TryGetValue(name, out var existing))
        {
            return existing;
        }

        if (!AutoCreate)
        {
            throw UnknownNameError.ForName(name);
        }

        var index = _store.AllocateIndex();
        Bind(name, index);
        if (!_store.Has(index))
        {
            _store.Create(index, index, index);
        }

        return index;
    }

    /// <summary>
    /// Associate a name with an existing index (no materialisation).
    /// </summary>
    /// <param name="name">The label.</param>
    /// <param name="index">The index to bind it to.</param>
    /// <returns>The index.</returns>
    public long Bind(string name, long index)
    {
        if (!_byName.ContainsKey(name))
        {
            _order.Add(name);
        }

        _byName[name] = index;
        _byIndex[index] = name;
        _store.ReserveIndex(index);
        return index;
    }

    /// <summary>
    /// Look up the label associated with an index.
    /// </summary>
    /// <param name="index">The link index.</param>
    /// <returns>The label, or <see langword="null"/> when none.</returns>
    public string? NameOf(long index) =>
        _byIndex.TryGetValue(index, out var name) ? name : null;

    /// <summary>All <c>(name, index)</c> associations, in insertion order.</summary>
    /// <returns>An ordered list of label/index pairs.</returns>
    public IReadOnlyList<(string Name, long Index)> Entries()
    {
        var result = new List<(string, long)>(_order.Count);
        foreach (var name in _order)
        {
            result.Add((name, _byName[name]));
        }

        return result;
    }

    /// <summary>Remove every name association (used by <see cref="Database.Clear"/>).</summary>
    internal void Clear()
    {
        _byName.Clear();
        _byIndex.Clear();
        _order.Clear();
    }
}
