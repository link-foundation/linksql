using System.Globalization;
using System.Text;

namespace LinksQL;

/// <summary>
/// The kind of a LiNo <see cref="Token"/>, mirroring the JavaScript token
/// <c>type</c> strings (<c>lparen</c>, <c>rparen</c>, <c>colon</c>, <c>ref</c>).
/// </summary>
public enum TokenKind
{
    /// <summary>An opening parenthesis <c>(</c>.</summary>
    LParen,

    /// <summary>A closing parenthesis <c>)</c>.</summary>
    RParen,

    /// <summary>A colon <c>:</c> separating an identity from its values.</summary>
    Colon,

    /// <summary>A reference (bareword or quoted string).</summary>
    Ref,
}

/// <summary>
/// A token produced by <see cref="Lino.Tokenize(string)"/>.
/// </summary>
public abstract record Token
{
    /// <summary>Gets the source offset where this token begins.</summary>
    public int Position { get; }

    /// <summary>Gets the discriminating <see cref="TokenKind"/> of this token.</summary>
    public abstract TokenKind Kind { get; }

    /// <summary>Initializes a new instance of the <see cref="Token"/> class.</summary>
    /// <param name="position">The source offset where this token begins.</param>
    protected Token(int position) => Position = position;

    /// <summary>An opening parenthesis <c>(</c>.</summary>
    public sealed record LParen(int Position) : Token(Position)
    {
        /// <inheritdoc/>
        public override TokenKind Kind => TokenKind.LParen;
    }

    /// <summary>A closing parenthesis <c>)</c>.</summary>
    public sealed record RParen(int Position) : Token(Position)
    {
        /// <inheritdoc/>
        public override TokenKind Kind => TokenKind.RParen;
    }

    /// <summary>A colon <c>:</c>.</summary>
    public sealed record Colon(int Position) : Token(Position)
    {
        /// <inheritdoc/>
        public override TokenKind Kind => TokenKind.Colon;
    }

    /// <summary>
    /// A reference token carrying the <see cref="Node"/> reference it produced.
    /// </summary>
    public sealed record RefToken(Node Ref, int Position) : Token(Position)
    {
        /// <inheritdoc/>
        public override TokenKind Kind => TokenKind.Ref;
    }
}

/// <summary>
/// An abstract syntax node: either a reference leaf or a (possibly nested) link.
/// </summary>
/// <remarks>
/// Mirrors the JavaScript node union of reference nodes
/// (<c>{ type: "ref", kind, value }</c>) and link nodes
/// (<c>{ type: "link", id, values }</c>).
/// </remarks>
public abstract record Node;

/// <summary>A numeric reference (an integer index).</summary>
/// <param name="Value">The integer value.</param>
public sealed record NumberRef(long Value) : Node;

/// <summary>A named reference (a human-readable label).</summary>
/// <param name="Value">The label.</param>
public sealed record NameRef(string Value) : Node;

/// <summary>A variable reference, written <c>$name</c>.</summary>
/// <param name="Value">The variable name, without the leading <c>$</c>.</param>
public sealed record VariableRef(string Value) : Node;

/// <summary>The wildcard <c>*</c>.</summary>
public sealed record WildcardRef : Node;

/// <summary>
/// A link node: <c>( [ id ":" ] values... )</c>.
/// </summary>
/// <param name="Id">
/// The optional identity (a reference or a nested link), or <c>null</c> when
/// absent.
/// </param>
/// <param name="Values">The ordered list of value nodes.</param>
/// <remarks>
/// Equality is structural and deep: two link nodes are equal when their
/// identities are equal and their <see cref="Values"/> are equal element-by-element.
/// This mirrors the JavaScript reference tests, which compare parsed ASTs with a
/// deep <c>toEqual</c>. The compiler-generated record equality would otherwise
/// compare the <see cref="Values"/> list by reference, so it is overridden here.
/// </remarks>
public sealed record LinkNode(Node? Id, IReadOnlyList<Node> Values) : Node
{
    /// <summary>Determines whether this link node equals another, comparing values element-wise.</summary>
    /// <param name="other">The link node to compare against.</param>
    /// <returns><see langword="true"/> when the identities and value sequences are equal.</returns>
    public bool Equals(LinkNode? other)
    {
        if (other is null)
        {
            return false;
        }

        if (ReferenceEquals(this, other))
        {
            return true;
        }

        return EqualityComparer<Node?>.Default.Equals(Id, other.Id)
            && Values.SequenceEqual(other.Values);
    }

    /// <inheritdoc/>
    public override int GetHashCode()
    {
        var hash = default(HashCode);
        hash.Add(Id);
        foreach (var value in Values)
        {
            hash.Add(value);
        }

        return hash.ToHashCode();
    }
}

/// <summary>
/// Links Notation (LiNo) parser and serializer.
/// </summary>
/// <remarks>
/// <para>
/// LiNo represents associative data as nested links. Every link has the form
/// <c>(index: source target)</c> where <c>index</c> (the identity) is optional
/// and the values are themselves references or links. The notation is the
/// surface syntax for the LinksQL substitution model.
/// </para>
/// <para>The grammar implemented here is:</para>
/// <code>
/// document  = { value } ;
/// value     = link | reference ;
/// link      = "(" [ value ":" ] { value } ")" ;
/// reference = number | name | variable | wildcard | string ;
/// variable  = "$" name ;
/// wildcard  = "*" ;
/// </code>
/// </remarks>
public static class Lino
{
    /// <summary>Characters treated as whitespace (token separators).</summary>
    private static bool IsWhitespace(char ch) =>
        ch is ' ' or '\t' or '\n' or '\r' or '\f' or '\v';

    /// <summary>Characters that terminate a bareword and/or carry their own meaning.</summary>
    private static bool IsDelimiter(char ch) =>
        ch is '(' or ')' or ':' or '"' or '\'';

    /// <summary>Whether a name must be quoted on output (whitespace or a delimiter).</summary>
    private static bool QuoteRequired(string name)
    {
        foreach (var ch in name)
        {
            if (IsWhitespace(ch) || ch is '(' or ')' or ':' or '"' or '\'')
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Classify a bareword (a run of non-delimiter characters) into a reference
    /// node. Numbers become numeric references, <c>$x</c> becomes a variable,
    /// <c>*</c> becomes a wildcard, and everything else becomes a name.
    /// </summary>
    private static Node ClassifyWord(string word)
    {
        if (word == "*")
        {
            return new WildcardRef();
        }

        if (word.Length > 0 && word[0] == '$')
        {
            return new VariableRef(word[1..]);
        }

        if (word.Length > 0 && IsAllDigits(word))
        {
            return new NumberRef(long.Parse(word, CultureInfo.InvariantCulture));
        }

        return new NameRef(word);
    }

    /// <summary>Whether every character of <paramref name="word"/> is an ASCII digit.</summary>
    private static bool IsAllDigits(string word)
    {
        foreach (var ch in word)
        {
            if (ch is < '0' or > '9')
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Read a quoted string starting at <paramref name="start"/> (which points at
    /// the opening quote).
    /// </summary>
    /// <param name="input">The full source text.</param>
    /// <param name="start">Index of the opening quote.</param>
    /// <param name="next">The index just past the closing quote.</param>
    /// <returns>A name reference token for the unescaped string.</returns>
    private static Token.RefToken ReadString(string input, int start, out int next)
    {
        var quote = input[start];
        var i = start + 1;
        var value = new StringBuilder();
        while (i < input.Length && input[i] != quote)
        {
            if (input[i] == '\\' && i + 1 < input.Length)
            {
                value.Append(input[i + 1]);
                i += 2;
            }
            else
            {
                value.Append(input[i]);
                i += 1;
            }
        }

        if (i >= input.Length)
        {
            throw new LinoSyntaxError("Unterminated quoted string", start);
        }

        next = i + 1;

        // A quoted token is ALWAYS a name, even if it looks numeric / `$x` / `*`.
        return new Token.RefToken(new NameRef(value.ToString()), start);
    }

    /// <summary>
    /// Split LiNo source text into a flat list of tokens.
    /// </summary>
    /// <param name="input">LiNo source text.</param>
    /// <returns>Ordered tokens.</returns>
    public static IReadOnlyList<Token> Tokenize(string input)
    {
        ArgumentNullException.ThrowIfNull(input);

        var tokens = new List<Token>();
        var i = 0;
        while (i < input.Length)
        {
            var ch = input[i];
            if (IsWhitespace(ch))
            {
                i += 1;
            }
            else if (ch == '(')
            {
                tokens.Add(new Token.LParen(i));
                i += 1;
            }
            else if (ch == ')')
            {
                tokens.Add(new Token.RParen(i));
                i += 1;
            }
            else if (ch == ':')
            {
                tokens.Add(new Token.Colon(i));
                i += 1;
            }
            else if (ch is '"' or '\'')
            {
                tokens.Add(ReadString(input, i, out var next));
                i = next;
            }
            else
            {
                var start = i;
                var word = new StringBuilder();
                while (i < input.Length && !IsWhitespace(input[i]))
                {
                    if (IsDelimiter(input[i]))
                    {
                        break;
                    }

                    word.Append(input[i]);
                    i += 1;
                }

                tokens.Add(new Token.RefToken(ClassifyWord(word.ToString()), start));
            }
        }

        return tokens;
    }

    /// <summary>A parser cursor over a flat token list.</summary>
    private sealed class ParserState
    {
        private readonly IReadOnlyList<Token> _tokens;

        public ParserState(IReadOnlyList<Token> tokens) => _tokens = tokens;

        public int Index { get; private set; }

        public int Count => _tokens.Count;

        public Token? Peek() => Index < _tokens.Count ? _tokens[Index] : null;

        public Token Advance() => _tokens[Index++];
    }

    /// <summary>Parse a single value (a reference or a parenthesized link).</summary>
    private static Node ParseValue(ParserState state)
    {
        var token = state.Peek();
        if (token is null)
        {
            throw new LinoSyntaxError("Unexpected end of input", -1);
        }

        if (token is Token.LParen)
        {
            return ParseLink(state);
        }

        if (token is Token.RefToken refToken)
        {
            state.Advance();
            return refToken.Ref;
        }

        throw new LinoSyntaxError($"Unexpected '{TokenTypeName(token)}'", token.Position);
    }

    /// <summary>The JavaScript token <c>type</c> name used in diagnostics.</summary>
    private static string TokenTypeName(Token token) => token.Kind switch
    {
        TokenKind.LParen => "lparen",
        TokenKind.RParen => "rparen",
        TokenKind.Colon => "colon",
        _ => "ref",
    };

    /// <summary>Parse a link: <c>(</c> [ value <c>:</c> ] values... <c>)</c>.</summary>
    private static LinkNode ParseLink(ParserState state)
    {
        state.Advance(); // consume '('
        if (state.Peek() is Token.RParen)
        {
            state.Advance();
            return new LinkNode(null, Array.Empty<Node>());
        }

        var first = ParseValue(state);
        Node? id = null;
        var values = new List<Node>();
        if (state.Peek() is Token.Colon)
        {
            state.Advance(); // consume ':'
            id = first;
        }
        else
        {
            values.Add(first);
        }

        while (state.Peek() is { } next && next is not Token.RParen)
        {
            values.Add(ParseValue(state));
        }

        var closing = state.Peek();
        if (closing is not Token.RParen)
        {
            throw new LinoSyntaxError("Expected )", closing?.Position ?? -1);
        }

        state.Advance(); // consume ')'
        return new LinkNode(id, values);
    }

    /// <summary>
    /// Parse LiNo source text into a list of top-level AST nodes.
    /// </summary>
    /// <param name="input">LiNo source text.</param>
    /// <returns>Top-level nodes (links and references).</returns>
    public static IReadOnlyList<Node> Parse(string input)
    {
        ArgumentNullException.ThrowIfNull(input);

        var state = new ParserState(Tokenize(input));
        var values = new List<Node>();
        while (state.Index < state.Count)
        {
            values.Add(ParseValue(state));
        }

        return values;
    }

    /// <summary>
    /// Quote a name for output if it contains characters that would otherwise be
    /// interpreted as structure, escaping <c>\</c> and <c>"</c>.
    /// </summary>
    private static string QuoteName(string name)
    {
        if (name.Length == 0 || QuoteRequired(name))
        {
            var escaped = name.Replace("\\", "\\\\", StringComparison.Ordinal)
                .Replace("\"", "\\\"", StringComparison.Ordinal);
            return $"\"{escaped}\"";
        }

        return name;
    }

    /// <summary>
    /// Serialize an AST node (reference or link) back to LiNo text.
    /// </summary>
    /// <param name="node">AST node.</param>
    /// <returns>LiNo text.</returns>
    public static string Serialize(Node node)
    {
        ArgumentNullException.ThrowIfNull(node);

        switch (node)
        {
            case VariableRef variable:
                return $"${variable.Value}";
            case WildcardRef:
                return "*";
            case NumberRef number:
                return number.Value.ToString(CultureInfo.InvariantCulture);
            case NameRef name:
                return QuoteName(name.Value);
            case LinkNode link:
                var body = string.Join(" ", link.Values.Select(Serialize));
                if (link.Id is not null)
                {
                    var id = Serialize(link.Id);
                    return body.Length > 0 ? $"({id}: {body})" : $"({id}:)";
                }

                return $"({body})";
            default:
                throw new ArgumentException($"Unknown node type: {node.GetType().Name}", nameof(node));
        }
    }

    /// <summary>
    /// Serialize a sequence of top-level nodes to LiNo text, joined by
    /// <paramref name="joiner"/>.
    /// </summary>
    /// <param name="nodes">Top-level nodes.</param>
    /// <param name="joiner">Separator between nodes (default newline).</param>
    /// <returns>LiNo text.</returns>
    public static string SerializeAll(IEnumerable<Node> nodes, string joiner = "\n")
    {
        ArgumentNullException.ThrowIfNull(nodes);

        return string.Join(joiner, nodes.Select(Serialize));
    }
}
