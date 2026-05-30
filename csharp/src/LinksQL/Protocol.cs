using System.Globalization;

namespace LinksQL;

/// <summary>
/// A generic, JSON-shaped value — the lingua franca between typed engine
/// structures (<see cref="QueryReport"/>, <see cref="Link"/>) and Links Notation
/// text.
/// </summary>
/// <remarks>
/// This is a closed discriminated union mirroring the JavaScript reference's
/// plain-object model. Conversions to and from the typed engine reports live on
/// <see cref="Protocol"/>; <see cref="Protocol.Encode(LinoValue)"/> renders a
/// value to Links Notation and <see cref="Protocol.Decode(string)"/> parses it
/// back.
/// </remarks>
public abstract record LinoValue
{
    private LinoValue()
    {
    }

    /// <summary>The null value.</summary>
    public sealed record Null : LinoValue;

    /// <summary>A boolean value.</summary>
    /// <param name="Value">The wrapped boolean.</param>
    public sealed record Bool(bool Value) : LinoValue;

    /// <summary>An integer value.</summary>
    /// <param name="Value">The wrapped integer.</param>
    public sealed record Int(long Value) : LinoValue;

    /// <summary>A floating-point value.</summary>
    /// <param name="Value">The wrapped number.</param>
    public sealed record Float(double Value) : LinoValue;

    /// <summary>A string value.</summary>
    /// <param name="Value">The wrapped text.</param>
    public sealed record Str(string Value) : LinoValue;

    /// <summary>An ordered array of values.</summary>
    /// <param name="Items">The contained items, in order.</param>
    public sealed record Arr(IReadOnlyList<LinoValue> Items) : LinoValue
    {
        /// <summary>Determines structural equality, comparing items element-wise.</summary>
        /// <param name="other">The array to compare against.</param>
        /// <returns><see langword="true"/> when both arrays hold equal items in order.</returns>
        public bool Equals(Arr? other) =>
            other is not null && Items.SequenceEqual(other.Items);

        /// <inheritdoc/>
        public override int GetHashCode()
        {
            var hash = default(HashCode);
            foreach (var item in Items)
            {
                hash.Add(item);
            }

            return hash.ToHashCode();
        }
    }

    /// <summary>
    /// An object as ordered key/value pairs (insertion order is significant).
    /// </summary>
    /// <param name="Pairs">The contained pairs, in order.</param>
    public sealed record Obj(IReadOnlyList<KeyValuePair<string, LinoValue>> Pairs) : LinoValue
    {
        /// <summary>Determines structural equality, comparing pairs element-wise.</summary>
        /// <param name="other">The object to compare against.</param>
        /// <returns><see langword="true"/> when both objects hold equal pairs in order.</returns>
        public bool Equals(Obj? other) =>
            other is not null && Pairs.SequenceEqual(other.Pairs);

        /// <inheritdoc/>
        public override int GetHashCode()
        {
            var hash = default(HashCode);
            foreach (var pair in Pairs)
            {
                hash.Add(pair.Key);
                hash.Add(pair.Value);
            }

            return hash.ToHashCode();
        }
    }
}

/// <summary>
/// LinksQL wire protocol — Links Notation as the data transfer format.
/// </summary>
/// <remarks>
/// <para>
/// The issue (and the PR review) is explicit: Links Notation, not JSON, is the
/// actual data protocol. Every structured value that crosses the network — query
/// reports, link lists, introspection snapshots — travels as Links Notation
/// text. Inside a process we work with typed values (<see cref="QueryReport"/>,
/// <see cref="Link"/>), so this class is the single boundary that converts
/// between the two through a generic <see cref="LinoValue"/> tree.
/// </para>
/// <para>
/// This is a faithful, behaviourally-identical port of the
/// <c>lino-objects-codec</c> convention used by the JavaScript reference
/// implementation (see <c>js/src</c>):
/// </para>
/// <list type="bullet">
///   <item>an object becomes a link of key/value pairs: <c>((key value) ...)</c></item>
///   <item>an array becomes a link of its elements: <c>(a b c)</c></item>
///   <item>an empty object or array becomes <c>()</c></item>
///   <item><c>null</c> becomes <c>null</c>; numbers/booleans become literal text</item>
///   <item>strings are escaped only when they contain whitespace, quotes,
///   parentheses, colons or newlines</item>
/// </list>
/// </remarks>
public static class Protocol
{
    /// <summary>The canonical content type for Links Notation payloads.</summary>
    public const string LinoContentType = "application/lino";

    /// <summary>The opt-in content type for the JSON projection of a payload.</summary>
    public const string JsonContentType = "application/json";

    /// <summary>
    /// Whether a string needs escaping: it contains whitespace, a quote, a
    /// parenthesis, a colon, or a newline (mirrors the codec's <c>/[\s()'":]/</c>).
    /// </summary>
    private static bool NeedsEscaping(string text)
    {
        foreach (var ch in text)
        {
            if (char.IsWhiteSpace(ch) || ch is '(' or ')' or '\'' or '"' or ':')
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Escape a string for use as a Links Notation reference, preferring whichever
    /// quote minimises internal escaping. Faithful port of <c>escapeReference</c>.
    /// </summary>
    /// <param name="text">The raw string value.</param>
    /// <returns>The escaped (and, if needed, quoted) reference text.</returns>
    public static string EscapeReference(string text)
    {
        ArgumentNullException.ThrowIfNull(text);

        if (!NeedsEscaping(text))
        {
            return text;
        }

        var hasSingle = text.Contains('\'', StringComparison.Ordinal);
        var hasDouble = text.Contains('"', StringComparison.Ordinal);
        if (hasSingle && !hasDouble)
        {
            return $"\"{text}\"";
        }

        if (hasDouble && !hasSingle)
        {
            return $"'{text}'";
        }

        if (hasSingle && hasDouble)
        {
            var singleCount = text.Count(ch => ch == '\'');
            var doubleCount = text.Count(ch => ch == '"');
            if (doubleCount < singleCount)
            {
                return $"\"{text.Replace("\"", "\"\"", StringComparison.Ordinal)}\"";
            }

            return $"'{text.Replace("'", "''", StringComparison.Ordinal)}'";
        }

        // Just spaces or other special characters: single-quote by default.
        return $"'{text}'";
    }

    /// <summary>
    /// Render a double the way JavaScript's <c>String(value)</c> would:
    /// integer-valued, finite numbers print without a trailing <c>.0</c>.
    /// </summary>
    private static string FloatToText(double value)
    {
        if (double.IsFinite(value) && Math.Floor(value) == value)
        {
            return value.ToString("0", CultureInfo.InvariantCulture);
        }

        return value.ToString("R", CultureInfo.InvariantCulture);
    }

    /// <summary>Encode a <see cref="LinoValue"/> as Links Notation text.</summary>
    /// <param name="value">The value to render.</param>
    /// <returns>The value rendered as Links Notation.</returns>
    public static string Encode(LinoValue value)
    {
        ArgumentNullException.ThrowIfNull(value);

        return value switch
        {
            LinoValue.Null => "null",
            LinoValue.Bool boolean => boolean.Value ? "true" : "false",
            LinoValue.Int integer => integer.Value.ToString(CultureInfo.InvariantCulture),
            LinoValue.Float number => FloatToText(number.Value),
            LinoValue.Str text => EscapeReference(text.Value),
            LinoValue.Arr array => EncodeArray(array.Items),
            LinoValue.Obj obj => EncodeObject(obj.Pairs),
            _ => throw new ArgumentOutOfRangeException(nameof(value)),
        };
    }

    private static string EncodeArray(IReadOnlyList<LinoValue> items)
    {
        if (items.Count == 0)
        {
            return "()";
        }

        return "(" + string.Join(" ", items.Select(Encode)) + ")";
    }

    private static string EncodeObject(IReadOnlyList<KeyValuePair<string, LinoValue>> pairs)
    {
        if (pairs.Count == 0)
        {
            return "()";
        }

        var parts = pairs.Select(pair =>
            $"({EscapeReference(pair.Key)} {Encode(pair.Value)})");
        return "(" + string.Join(" ", parts) + ")";
    }

    /// <summary>
    /// Parse a reference's text into a primitive value (true/false/null/number/string).
    /// </summary>
    private static LinoValue ParseReference(string text)
    {
        switch (text)
        {
            case "true":
                return new LinoValue.Bool(true);
            case "false":
                return new LinoValue.Bool(false);
            case "null":
                return new LinoValue.Null();
            default:
                break;
        }

        if (text.Trim().Length != 0)
        {
            if (long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var integer))
            {
                return new LinoValue.Int(integer);
            }

            if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number))
            {
                return new LinoValue.Float(number);
            }
        }

        return new LinoValue.Str(text);
    }

    /// <summary>Convert a reference node into a primitive value.</summary>
    private static LinoValue ReferenceValue(Node node) => node switch
    {
        NumberRef number => new LinoValue.Int(number.Value),
        NameRef name => ParseReference(name.Value),
        VariableRef variable => new LinoValue.Str($"${variable.Value}"),
        WildcardRef => new LinoValue.Str("*"),
        _ => throw new ArgumentOutOfRangeException(nameof(node)),
    };

    /// <summary>
    /// Whether a node is a key/value pair with a string-like key (an object entry).
    /// </summary>
    private static bool IsPair(Node node)
    {
        if (node is not LinkNode link || link.Values.Count != 2)
        {
            return false;
        }

        if (link.Values[0] is not (NumberRef or NameRef or VariableRef or WildcardRef))
        {
            return false;
        }

        return ReferenceValue(link.Values[0]) is not (LinoValue.Int or LinoValue.Float);
    }

    /// <summary>Convert a parsed LiNo node into a <see cref="LinoValue"/>.</summary>
    private static LinoValue Convert(Node node)
    {
        if (node is not LinkNode link)
        {
            return ReferenceValue(node);
        }

        if (link.Values.Count == 0)
        {
            return link.Id is null ? new LinoValue.Arr([]) : Convert(link.Id);
        }

        if (link.Values.All(IsPair))
        {
            var pairs = new List<KeyValuePair<string, LinoValue>>(link.Values.Count);
            foreach (var child in link.Values)
            {
                var pair = (LinkNode)child;
                var key = Convert(pair.Values[0]) switch
                {
                    LinoValue.Str str => str.Value,
                    var other => Encode(other),
                };
                pairs.Add(new KeyValuePair<string, LinoValue>(key, Convert(pair.Values[1])));
            }

            return new LinoValue.Obj(pairs);
        }

        return new LinoValue.Arr(link.Values.Select(Convert).ToList());
    }

    /// <summary>Decode Links Notation text into a <see cref="LinoValue"/>.</summary>
    /// <param name="lino">Links Notation text produced by <see cref="Encode(LinoValue)"/>.</param>
    /// <returns>The reconstructed value.</returns>
    /// <exception cref="LinoSyntaxError">Thrown when <paramref name="lino"/> is malformed.</exception>
    public static LinoValue Decode(string lino)
    {
        if (string.IsNullOrEmpty(lino))
        {
            return new LinoValue.Null();
        }

        var nodes = Lino.Parse(lino);
        if (nodes.Count == 0)
        {
            return new LinoValue.Null();
        }

        var result = Convert(nodes[0]);

        // Unwrap a single primitive the parser wrapped in a one-element list.
        if (result is LinoValue.Arr { Items: { Count: 1 } items }
            && items[0] is LinoValue.Null or LinoValue.Bool or LinoValue.Int
                or LinoValue.Float or LinoValue.Str)
        {
            return items[0];
        }

        return result;
    }

    /// <summary>
    /// Whether a caller's <c>Accept</c>/<c>Content-Type</c> header opts into JSON.
    /// </summary>
    /// <remarks>
    /// Links Notation is always the default; JSON is only used when a client asks
    /// for it explicitly, and Links Notation wins when both are present.
    /// </remarks>
    /// <param name="header">An <c>Accept</c> or <c>Content-Type</c> header value.</param>
    /// <returns><see langword="true"/> when JSON should be used instead of Links Notation.</returns>
    public static bool PrefersJson(string? header)
    {
        if (string.IsNullOrEmpty(header))
        {
            return false;
        }

        var lower = header.ToUpperInvariant();
        if (lower.Contains(LinoContentType.ToUpperInvariant(), StringComparison.Ordinal))
        {
            return false;
        }

        return lower.Contains("APPLICATION/JSON", StringComparison.Ordinal)
            || lower.Contains("TEXT/JSON", StringComparison.Ordinal);
    }

    /// <summary>The lowercase wire name of an <see cref="Operation"/>.</summary>
    private static string OperationName(Operation operation) => operation switch
    {
        Operation.Read => "read",
        Operation.Create => "create",
        Operation.Update => "update",
        Operation.Delete => "delete",
        Operation.Mixed => "mixed",
        Operation.Noop => "noop",
        _ => throw new ArgumentOutOfRangeException(nameof(operation)),
    };

    /// <summary>Project a single link onto its <see cref="LinoValue"/> object.</summary>
    private static LinoValue FromLink(Link link) => new LinoValue.Obj(
    [
        new("index", new LinoValue.Int(link.Index)),
        new("source", new LinoValue.Int(link.Source)),
        new("target", new LinoValue.Int(link.Target)),
    ]);

    /// <summary>Project a list of links onto a <see cref="LinoValue"/> array.</summary>
    private static LinoValue.Arr LinksValue(IReadOnlyList<Link> links) =>
        new(links.Select(FromLink).ToList());

    /// <summary>Project a match row onto its <see cref="LinoValue"/> object.</summary>
    private static LinoValue FromMatchRow(MatchRow row)
    {
        var binding = new LinoValue.Obj(
            row.Binding.Select(entry =>
                new KeyValuePair<string, LinoValue>(entry.Key, new LinoValue.Int(entry.Value)))
                .ToList());
        return new LinoValue.Obj(
        [
            new("links", LinksValue(row.Links)),
            new("binding", binding),
        ]);
    }

    /// <summary>Project a query report onto its <see cref="LinoValue"/> object.</summary>
    /// <param name="report">The report to project.</param>
    /// <returns>The report as a <see cref="LinoValue"/> tree.</returns>
    public static LinoValue FromReport(QueryReport report)
    {
        ArgumentNullException.ThrowIfNull(report);

        return new LinoValue.Obj(
        [
            new("operation", new LinoValue.Str(OperationName(report.Operation))),
            new("matched", new LinoValue.Arr(report.Matched.Select(FromMatchRow).ToList())),
            new("created", LinksValue(report.Created)),
            new("updated", LinksValue(report.Updated)),
            new("deleted", LinksValue(report.Deleted)),
        ]);
    }

    /// <summary>Encode a query report directly as Links Notation text.</summary>
    /// <param name="report">The report to encode.</param>
    /// <returns>The report rendered as Links Notation.</returns>
    public static string EncodeReport(QueryReport report) => Encode(FromReport(report));

    /// <summary>Project an introspection snapshot onto its <see cref="LinoValue"/> object.</summary>
    /// <param name="report">The introspection snapshot to project.</param>
    /// <returns>The snapshot as a <see cref="LinoValue"/> tree.</returns>
    public static LinoValue FromIntrospection(IntrospectionReport report)
    {
        ArgumentNullException.ThrowIfNull(report);

        var names = new LinoValue.Arr(
            report.Names.Select(named => (LinoValue)new LinoValue.Obj(
            [
                new("name", new LinoValue.Str(named.Name)),
                new("index", new LinoValue.Int(named.Index)),
            ])).ToList());
        return new LinoValue.Obj(
        [
            new("linkCount", new LinoValue.Int(report.LinkCount)),
            new("names", names),
            new("links", LinksValue(report.Links)),
        ]);
    }

    /// <summary>Encode an introspection snapshot directly as Links Notation text.</summary>
    /// <param name="report">The introspection snapshot to encode.</param>
    /// <returns>The snapshot rendered as Links Notation.</returns>
    public static string EncodeIntrospection(IntrospectionReport report) =>
        Encode(FromIntrospection(report));

    /// <summary>
    /// Project a schema onto its <see cref="LinoValue"/> object — the GraphQL
    /// <c>__schema</c> introspection-document analogue, shaped like the JavaScript
    /// <c>schema.introspect()</c>.
    /// </summary>
    /// <param name="schema">The schema to project.</param>
    /// <returns>The schema as a <see cref="LinoValue"/> tree.</returns>
    public static LinoValue FromSchema(Schema schema)
    {
        ArgumentNullException.ThrowIfNull(schema);

        var relations = new LinoValue.Arr(
            schema.Relations.Select(relation => (LinoValue)new LinoValue.Obj(
            [
                new("name", new LinoValue.Str(relation.Name)),
                new("from", new LinoValue.Str(relation.From)),
                new("to", new LinoValue.Str(relation.To)),
            ])).ToList());
        var queries = new LinoValue.Arr(
            schema.Queries.Select(query => (LinoValue)new LinoValue.Obj(
            [
                new("name", new LinoValue.Str(query.Name)),
                new("text", new LinoValue.Str(query.Text)),
            ])).ToList());
        var subscriptions = new LinoValue.Arr(
            schema.Subscriptions.Select(sub => (LinoValue)new LinoValue.Obj(
            [
                new("name", new LinoValue.Str(sub.Name)),
                new("pattern", new LinoValue.Str(sub.Pattern)),
            ])).ToList());
        return new LinoValue.Obj(
        [
            new("name", schema.Name is null ? new LinoValue.Null() : new LinoValue.Str(schema.Name)),
            new("types", new LinoValue.Arr(schema.Types.Select(type => (LinoValue)new LinoValue.Str(type)).ToList())),
            new("scalars", new LinoValue.Arr(schema.Scalars.Select(scalar => (LinoValue)new LinoValue.Str(scalar)).ToList())),
            new("relations", relations),
            new("queries", queries),
            new("subscriptions", subscriptions),
        ]);
    }

    /// <summary>Encode a schema directly as Links Notation text.</summary>
    /// <param name="schema">The schema to encode.</param>
    /// <returns>The schema rendered as Links Notation.</returns>
    public static string EncodeSchema(Schema schema) => Encode(FromSchema(schema));
}
