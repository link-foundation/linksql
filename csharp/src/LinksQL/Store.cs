using System.Globalization;

namespace LinksQL;

/// <summary>
/// A link (doublet): a triple of integer identities.
/// </summary>
/// <param name="Index">The link's own unique identity.</param>
/// <param name="Source">The index this link points from.</param>
/// <param name="Target">The index this link points to.</param>
/// <remarks>
/// A link whose <paramref name="Source"/> and <paramref name="Target"/> both
/// equal its own <paramref name="Index"/> is a <em>point</em> — the atom of the
/// model.
/// </remarks>
public sealed record Link(long Index, long Source, long Target);

/// <summary>
/// In-memory doublets store: a mutable set of links addressed by integer
/// identity.
/// </summary>
/// <remarks>
/// <para>
/// The store owns identity allocation and enforces the associative invariant
/// that a <c>(source, target)</c> pair identifies at most one link
/// (deduplication). It is a pure data container: pattern matching and the
/// substitution operation live in <see cref="Substitution"/>.
/// </para>
/// <para>
/// <see cref="All"/> preserves insertion order (matching the JavaScript
/// <c>Map</c> iteration order) via a parallel order list; links are
/// <em>not</em> sorted by index. As in JavaScript, <see cref="Update"/> removes
/// and re-inserts the entry, so an updated link always moves to the end of
/// iteration order.
/// </para>
/// </remarks>
public sealed class LinksStore
{
    private readonly Dictionary<long, Link> _links = new();
    private readonly List<long> _order = new();
    private readonly Dictionary<(long Source, long Target), long> _byPair = new();

    /// <summary>Gets the next identity to hand out; kept above every used index.</summary>
    public long NextIndex { get; private set; } = 1;

    /// <summary>Gets the number of stored links.</summary>
    public int Size => _links.Count;

    /// <summary>Gets the number of stored links.</summary>
    public int Count => _links.Count;

    /// <summary>Whether a link with this identity exists.</summary>
    /// <param name="index">Identity to test.</param>
    /// <returns><see langword="true"/> if a link with this identity exists.</returns>
    public bool Has(long index) => _links.ContainsKey(index);

    /// <summary>Fetch a link by identity.</summary>
    /// <param name="index">Identity to fetch.</param>
    /// <returns>The link, or <see langword="null"/> when absent.</returns>
    public Link? Get(long index) => _links.TryGetValue(index, out var link) ? link : null;

    /// <summary>Look up a link by its <c>(source, target)</c> structure.</summary>
    /// <param name="source">Source index.</param>
    /// <param name="target">Target index.</param>
    /// <returns>The link, or <see langword="null"/> when absent.</returns>
    public Link? FindByPair(long source, long target) =>
        _byPair.TryGetValue((source, target), out var index) ? _links[index] : null;

    /// <summary>All links, in insertion order.</summary>
    /// <returns>An ordered list of every stored link.</returns>
    public IReadOnlyList<Link> All()
    {
        var result = new List<Link>(_order.Count);
        foreach (var index in _order)
        {
            result.Add(_links[index]);
        }

        return result;
    }

    /// <summary>Reserve a fresh identity, advancing the allocator past it.</summary>
    /// <returns>A previously-unused index.</returns>
    public long AllocateIndex()
    {
        while (_links.ContainsKey(NextIndex))
        {
            NextIndex += 1;
        }

        return NextIndex++;
    }

    /// <summary>Keep the allocator above an externally chosen identity.</summary>
    /// <param name="index">An index that is now in use.</param>
    public void ReserveIndex(long index)
    {
        if (index >= NextIndex)
        {
            NextIndex = index + 1;
        }
    }

    /// <summary>
    /// Create (or, by deduplication, return) a link.
    /// </summary>
    /// <param name="index">
    /// Explicit identity; auto-allocated when <see langword="null"/>.
    /// </param>
    /// <param name="source">Source index.</param>
    /// <param name="target">Target index.</param>
    /// <returns>The created or existing link.</returns>
    /// <exception cref="LinkIntegrityError">
    /// Thrown when an explicit index conflicts with an existing structure, is not
    /// a positive integer, or is already in use.
    /// </exception>
    public Link Create(long? index, long source, long target)
    {
        var existing = FindByPair(source, target);
        if (existing is not null)
        {
            if (index is not null && index.Value != existing.Index)
            {
                throw new LinkIntegrityError(
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"Link ({source} {target}) already exists as {existing.Index}, cannot also be {index.Value}"));
            }

            return existing;
        }

        long id;
        if (index is null)
        {
            id = AllocateIndex();
        }
        else
        {
            id = index.Value;
            if (id < 1)
            {
                throw new LinkIntegrityError("Link index must be a positive integer");
            }

            if (_links.ContainsKey(id))
            {
                throw new LinkIntegrityError(
                    string.Create(CultureInfo.InvariantCulture, $"Link index {id} is already in use"));
            }

            ReserveIndex(id);
        }

        var link = new Link(id, source, target);
        Insert(link);
        return link;
    }

    /// <summary>
    /// Replace the structure of an existing link, preserving its identity unless a
    /// new identity is requested.
    /// </summary>
    /// <param name="index">Identity of the link to update.</param>
    /// <param name="source">New source index.</param>
    /// <param name="target">New target index.</param>
    /// <param name="newIndex">Optional new identity (re-index).</param>
    /// <returns>The updated link.</returns>
    /// <exception cref="LinkIntegrityError">
    /// Thrown when the link is missing, the new structure collides with a
    /// <em>different</em> link, or a requested new index is already in use.
    /// </exception>
    public Link Update(long index, long source, long target, long? newIndex)
    {
        if (!_links.TryGetValue(index, out var current))
        {
            throw new LinkIntegrityError(
                string.Create(CultureInfo.InvariantCulture, $"Cannot update missing link {index}"));
        }

        var id = newIndex ?? index;
        var collision = FindByPair(source, target);
        if (collision is not null && collision.Index != index)
        {
            throw new LinkIntegrityError(
                string.Create(
                    CultureInfo.InvariantCulture,
                    $"Cannot update link {index}: ({source} {target}) already exists as {collision.Index}"));
        }

        if (id != index && _links.ContainsKey(id))
        {
            throw new LinkIntegrityError(
                string.Create(CultureInfo.InvariantCulture, $"Link index {id} is already in use"));
        }

        // Mirror the JavaScript Map semantics exactly: delete the old key then set
        // the new one. In JS, `map.delete(k); map.set(k, v)` re-appends the entry
        // even when the key is unchanged, so `update` always moves the link to the
        // end of iteration order.
        _byPair.Remove((current.Source, current.Target));
        _order.Remove(index);
        _links.Remove(index);

        var link = new Link(id, source, target);
        _links[id] = link;
        _order.Add(id);
        _byPair[(source, target)] = id;
        ReserveIndex(id);
        return link;
    }

    /// <summary>Remove a link by identity.</summary>
    /// <param name="index">Identity to remove.</param>
    /// <returns><see langword="true"/> if a link was removed.</returns>
    public bool Delete(long index)
    {
        if (!_links.TryGetValue(index, out var current))
        {
            return false;
        }

        _byPair.Remove((current.Source, current.Target));
        _order.Remove(index);
        _links.Remove(index);
        return true;
    }

    /// <summary>Remove every link and reset identity allocation.</summary>
    public void Clear()
    {
        _links.Clear();
        _order.Clear();
        _byPair.Clear();
        NextIndex = 1;
    }

    /// <summary>Insert a link, recording insertion order and the pair index.</summary>
    private void Insert(Link link)
    {
        _links[link.Index] = link;
        _order.Add(link.Index);
        _byPair[(link.Source, link.Target)] = link.Index;
    }
}
