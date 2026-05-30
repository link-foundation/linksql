using System.Globalization;
using System.Text;

namespace LinksQL;

/// <summary>
/// A typed relation (the GraphQL field/edge analogue): a named edge from one
/// type to another.
/// </summary>
/// <param name="Name">The relation name.</param>
/// <param name="From">The source endpoint type name.</param>
/// <param name="To">The target endpoint type name.</param>
public sealed record Relation(string Name, string From, string To);

/// <summary>A named, reusable read template (the GraphQL named query analogue).</summary>
/// <param name="Name">The query name.</param>
/// <param name="Text">The query template, as Links Notation text.</param>
public sealed record NamedQuery(string Name, string Text);

/// <summary>A named live feed (the GraphQL subscription analogue).</summary>
/// <param name="Name">The subscription name.</param>
/// <param name="Pattern">The watched restriction, as Links Notation text.</param>
public sealed record NamedSubscription(string Name, string Pattern);

/// <summary>
/// A declarative description of a LinksQL API — the GraphQL-class schema layer.
/// </summary>
/// <remarks>
/// <para>
/// A schema is itself written in Links Notation (the data protocol), so the same
/// notation describes data <em>and</em> the shape of the API that serves it:
/// </para>
/// <code>
/// (schema social
///   (type Person)
///   (type Post)
///   (relation name (from Person) (to Text))
///   (relation author (from Post) (to Person))
///   (relation likes (from Person) (to Post))
///   (query everyone (($p: $p $p)))
///   (subscription newLikes ((1 $post))))
/// </code>
/// <para>The GraphQL analogy is direct:</para>
/// <list type="bullet">
///   <item><c>type</c> ⇔ object type</item>
///   <item><c>relation</c> ⇔ a typed field/edge (<c>from</c> → <c>to</c>)</item>
///   <item>a scalar type ⇔ any relation endpoint that is not a declared object type</item>
///   <item><c>query</c> ⇔ a named, reusable read</item>
///   <item><c>subscription</c> ⇔ a named live feed</item>
/// </list>
/// <para>
/// This C# port is engine-only: it supplies the schema data model (parse,
/// introspect, render) but not the server generation of the JavaScript reference.
/// </para>
/// </remarks>
public sealed class Schema
{
    /// <summary>The declaration keywords a schema understands.</summary>
    private static readonly string[] Keywords = ["type", "relation", "query", "subscription"];

    /// <summary>Initializes a new instance of the <see cref="Schema"/> class.</summary>
    /// <param name="name">The schema's name, or <see langword="null"/>.</param>
    /// <param name="types">Declared object type names.</param>
    /// <param name="scalars">Scalar type names (relation endpoints that are not declared object types).</param>
    /// <param name="relations">Typed relations (the GraphQL fields/edges).</param>
    /// <param name="queries">Named read templates.</param>
    /// <param name="subscriptions">Named live feeds.</param>
    public Schema(
        string? name,
        IReadOnlyList<string> types,
        IReadOnlyList<string> scalars,
        IReadOnlyList<Relation> relations,
        IReadOnlyList<NamedQuery> queries,
        IReadOnlyList<NamedSubscription> subscriptions)
    {
        ArgumentNullException.ThrowIfNull(types);
        ArgumentNullException.ThrowIfNull(scalars);
        ArgumentNullException.ThrowIfNull(relations);
        ArgumentNullException.ThrowIfNull(queries);
        ArgumentNullException.ThrowIfNull(subscriptions);

        Name = name;
        Types = types.ToArray();
        Scalars = scalars.ToArray();
        Relations = relations.ToArray();
        Queries = queries.ToArray();
        Subscriptions = subscriptions.ToArray();
    }

    /// <summary>Gets the schema's name, or <see langword="null"/> when anonymous.</summary>
    public string? Name { get; }

    /// <summary>Gets the declared object type names, in declaration order.</summary>
    public IReadOnlyList<string> Types { get; }

    /// <summary>Gets the inferred scalar type names, in first-seen order.</summary>
    public IReadOnlyList<string> Scalars { get; }

    /// <summary>Gets the declared relations, in declaration order.</summary>
    public IReadOnlyList<Relation> Relations { get; }

    /// <summary>Gets the named query templates, in declaration order.</summary>
    public IReadOnlyList<NamedQuery> Queries { get; }

    /// <summary>Gets the named subscriptions, in declaration order.</summary>
    public IReadOnlyList<NamedSubscription> Subscriptions { get; }

    /// <summary>
    /// Parse a schema written in Links Notation.
    /// </summary>
    /// <param name="text">The schema document.</param>
    /// <returns>The parsed schema.</returns>
    /// <exception cref="SchemaError">Thrown when the schema is malformed.</exception>
    public static Schema Parse(string text)
    {
        ArgumentNullException.ThrowIfNull(text);

        IReadOnlyList<Node> nodes;
        try
        {
            nodes = Lino.Parse(text);
        }
        catch (LinoSyntaxError error)
        {
            throw new SchemaError($"Invalid LiNo schema: {error.Message}", error);
        }

        if (nodes.Count != 1 || nodes[0] is not LinkNode root)
        {
            throw new SchemaError("A schema must be a single `(schema ...)` link");
        }

        var values = new List<Node>(root.Values);
        if (values.Count == 0 || values[0] is not NameRef head ||
            !string.Equals(head.Value, "schema", StringComparison.Ordinal))
        {
            throw new SchemaError("A schema must start with the `schema` keyword");
        }

        values.RemoveAt(0);

        // An optional bare name may follow the `schema` keyword.
        string? name = null;
        if (values.Count > 0 && IsRef(values[0]))
        {
            name = RefName(values[0], "schema name");
            values.RemoveAt(0);
        }

        var types = new List<string>();
        var relations = new List<Relation>();
        var queries = new List<NamedQuery>();
        var subscriptions = new List<NamedSubscription>();
        foreach (var declaration in values)
        {
            CollectDeclaration(declaration, types, relations, queries, subscriptions);
        }

        var scalars = InferScalars(relations, types);

        return new Schema(name, types, scalars, relations, queries, subscriptions);
    }

    /// <summary>Look up a relation by name.</summary>
    /// <param name="name">The relation name.</param>
    /// <returns>The relation, or <see langword="null"/> when not declared.</returns>
    public Relation? FindRelation(string name) =>
        Relations.FirstOrDefault(relation => string.Equals(relation.Name, name, StringComparison.Ordinal));

    /// <summary>Look up a named query.</summary>
    /// <param name="name">The query name.</param>
    /// <returns>The query template, or <see langword="null"/> when not declared.</returns>
    public NamedQuery? FindQuery(string name) =>
        Queries.FirstOrDefault(query => string.Equals(query.Name, name, StringComparison.Ordinal));

    /// <summary>Look up a named subscription.</summary>
    /// <param name="name">The subscription name.</param>
    /// <returns>The subscription, or <see langword="null"/> when not declared.</returns>
    public NamedSubscription? FindSubscription(string name) =>
        Subscriptions.FirstOrDefault(sub => string.Equals(sub.Name, name, StringComparison.Ordinal));

    /// <summary>Whether a name is a declared type, scalar or relation.</summary>
    /// <param name="name">The name to test.</param>
    /// <returns><see langword="true"/> when the schema declares it.</returns>
    public bool Knows(string name) =>
        Types.Contains(name, StringComparer.Ordinal) ||
        Scalars.Contains(name, StringComparer.Ordinal) ||
        Relations.Any(relation => string.Equals(relation.Name, name, StringComparison.Ordinal));

    /// <summary>Assert that a relation is declared, throwing otherwise.</summary>
    /// <param name="name">The relation name to validate.</param>
    /// <returns>The relation.</returns>
    /// <exception cref="SchemaError">Thrown when the relation is not declared.</exception>
    public Relation ValidateRelation(string name)
    {
        var relation = FindRelation(name);
        if (relation is null)
        {
            throw new SchemaError($"Unknown relation \"{name}\"");
        }

        return relation;
    }

    /// <summary>Render the schema back to canonical Links Notation.</summary>
    /// <returns>The schema as a <c>(schema ...)</c> document.</returns>
    public string ToLino()
    {
        var declarations = new List<string>();
        foreach (var type in Types)
        {
            declarations.Add($"(type {Lino.Serialize(new NameRef(type))})");
        }

        foreach (var relation in Relations)
        {
            declarations.Add(
                $"(relation {relation.Name} (from {relation.From}) (to {relation.To}))");
        }

        foreach (var query in Queries)
        {
            declarations.Add($"(query {query.Name} {query.Text})");
        }

        foreach (var sub in Subscriptions)
        {
            declarations.Add($"(subscription {sub.Name} {sub.Pattern})");
        }

        var head = Name is null ? "schema" : $"schema {Name}";
        var body = new StringBuilder(head);
        foreach (var declaration in declarations)
        {
            body.Append(' ').Append(declaration);
        }

        return string.Create(CultureInfo.InvariantCulture, $"({body})");
    }

    /// <summary>Whether a node is a reference (any non-link node).</summary>
    private static bool IsRef(Node node) => node is not LinkNode;

    /// <summary>Read a reference node's name as a string.</summary>
    /// <param name="node">An AST node expected to be a reference.</param>
    /// <param name="context">What is being read, for error messages.</param>
    /// <returns>The reference's textual value.</returns>
    /// <exception cref="SchemaError">Thrown when the node is not a reference.</exception>
    private static string RefName(Node node, string context) => node switch
    {
        VariableRef variable => $"${variable.Value}",
        NameRef name => name.Value,
        NumberRef number => number.Value.ToString(CultureInfo.InvariantCulture),
        WildcardRef => "*",
        _ => throw new SchemaError($"Expected a name for {context}"),
    };

    /// <summary>
    /// Find a <c>(keyword value)</c> sub-link among a declaration's values and
    /// return the value's name.
    /// </summary>
    /// <param name="values">The declaration's value nodes.</param>
    /// <param name="keyword">The keyword to look for (e.g. <c>from</c>).</param>
    /// <param name="context">The declaration name, for error messages.</param>
    /// <returns>The named argument.</returns>
    /// <exception cref="SchemaError">Thrown when the keyword is missing.</exception>
    private static string NamedArg(IReadOnlyList<Node> values, string keyword, string context)
    {
        foreach (var value in values)
        {
            if (value is LinkNode link &&
                link.Values.Count == 2 &&
                link.Values[0] is NameRef first &&
                string.Equals(first.Value, keyword, StringComparison.Ordinal))
            {
                return RefName(link.Values[1], $"{keyword} of {context}");
            }
        }

        throw new SchemaError($"Relation \"{context}\" is missing its \"{keyword}\" type");
    }

    /// <summary>Sort one declaration link into the right collection.</summary>
    private static void CollectDeclaration(
        Node declaration,
        List<string> types,
        List<Relation> relations,
        List<NamedQuery> queries,
        List<NamedSubscription> subscriptions)
    {
        if (declaration is not LinkNode link || link.Values.Count == 0)
        {
            throw new SchemaError("Each schema declaration must be a link");
        }

        var keyword = RefName(link.Values[0], "declaration keyword");
        if (!Keywords.Contains(keyword, StringComparer.Ordinal))
        {
            throw new SchemaError(
                $"Unknown schema declaration \"{keyword}\" (expected {string.Join("|", Keywords)})");
        }

        var rest = link.Values.Skip(1).ToList();
        switch (keyword)
        {
            case "type":
                types.Add(RefName(rest[0], "type name"));
                break;
            case "relation":
                var relationName = RefName(rest[0], "relation name");
                relations.Add(new Relation(
                    relationName,
                    NamedArg(rest, "from", relationName),
                    NamedArg(rest, "to", relationName)));
                break;
            case "query":
                queries.Add(new NamedQuery(
                    RefName(rest[0], "query name"),
                    Lino.SerializeAll(rest.Skip(1), " ")));
                break;
            default:
                subscriptions.Add(new NamedSubscription(
                    RefName(rest[0], "subscription name"),
                    Lino.SerializeAll(rest.Skip(1), " ")));
                break;
        }
    }

    /// <summary>
    /// Derive scalar type names: any relation endpoint not declared as an object
    /// type, in first-seen order.
    /// </summary>
    private static List<string> InferScalars(IReadOnlyList<Relation> relations, IReadOnlyList<string> types)
    {
        var scalars = new List<string>();
        foreach (var relation in relations)
        {
            foreach (var endpoint in new[] { relation.From, relation.To })
            {
                if (!types.Contains(endpoint, StringComparer.Ordinal) &&
                    !scalars.Contains(endpoint, StringComparer.Ordinal))
                {
                    scalars.Add(endpoint);
                }
            }
        }

        return scalars;
    }
}
