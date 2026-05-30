using LinksQL;

namespace LinksQL.Tests;

/// <summary>
/// Tests for the Links Notation (LiNo) tokenizer, parser and serializer. Mirrors
/// <c>tests/lino.test.js</c> from the JavaScript reference implementation: every
/// assertion below is a behavioural requirement carried over 1:1.
/// </summary>
public class LinoTests
{
    [Fact]
    public void Tokenize_SplitsStructureAndWords()
    {
        var kinds = Lino.Tokenize("(1: 1 1)").Select(t => t.Kind).ToArray();
        Assert.Equal(
            new[]
            {
                TokenKind.LParen,
                TokenKind.Ref,
                TokenKind.Colon,
                TokenKind.Ref,
                TokenKind.Ref,
                TokenKind.RParen,
            },
            kinds);
    }

    [Fact]
    public void Tokenize_ReadsQuotedStringsWithEscapes()
    {
        var tokens = Lino.Tokenize("\"a\\\"b\"");
        Assert.Single(tokens);
        var token = Assert.IsType<Token.RefToken>(tokens[0]);
        var name = Assert.IsType<NameRef>(token.Ref);
        Assert.Equal("a\"b", name.Value);
    }

    [Fact]
    public void Parse_ClassifiesReferences()
    {
        Assert.Equal(new NumberRef(1), Lino.Parse("1")[0]);
        Assert.Equal(new VariableRef("x"), Lino.Parse("$x")[0]);
        Assert.Equal(new WildcardRef(), Lino.Parse("*")[0]);
        Assert.Equal(new NameRef("alice"), Lino.Parse("alice")[0]);
    }

    [Fact]
    public void Parse_LinkWithExplicitIdentity()
    {
        var node = Assert.IsType<LinkNode>(Lino.Parse("(1: 1 1)")[0]);
        Assert.Equal(new NumberRef(1), node.Id);
        Assert.Equal(2, node.Values.Count);
    }

    [Fact]
    public void Parse_EmptyLink()
    {
        var node = Assert.IsType<LinkNode>(Lino.Parse("()")[0]);
        Assert.Null(node.Id);
        Assert.Empty(node.Values);
    }

    [Fact]
    public void Parse_TwoValueQueryIntoTwoTopLevelNodes()
    {
        var nodes = Lino.Parse("() ((1 1))");
        Assert.Equal(2, nodes.Count);
        Assert.Empty(Assert.IsType<LinkNode>(nodes[0]).Values);
        Assert.Single(Assert.IsType<LinkNode>(nodes[1]).Values);
    }

    [Fact]
    public void Parse_NestedLinks()
    {
        var node = Assert.IsType<LinkNode>(Lino.Parse("((1 2) (3 4))")[0]);
        Assert.IsType<LinkNode>(node.Values[0]);
        Assert.IsType<LinkNode>(node.Values[1]);
    }

    [Fact]
    public void Parse_RejectsNonStringInput()
    {
        // The JavaScript test passes a number (`parse(42)`); the C# signature is
        // `string`, so the analogous "wrong input" is a null reference.
        Assert.Throws<ArgumentNullException>(() => Lino.Parse(null!));
    }

    [Fact]
    public void Parse_RejectsUnterminatedStrings()
    {
        Assert.Throws<LinoSyntaxError>(() => Lino.Parse("\"abc"));
    }

    [Fact]
    public void Parse_RejectsUnbalancedParentheses()
    {
        Assert.Throws<LinoSyntaxError>(() => Lino.Parse("(1 2"));
    }

    [Fact]
    public void Parse_ReportsLinoSyntaxErrorInstance()
    {
        Exception? caught = null;
        try
        {
            Lino.Parse("(1 2");
        }
        catch (LinoSyntaxError error)
        {
            caught = error;
        }

        Assert.IsType<LinoSyntaxError>(caught);
    }

    [Theory]
    [InlineData("1")]
    [InlineData("(1: 1 1)")]
    [InlineData("() ((1 1))")]
    [InlineData("((1: 1 1)) ((1: 1 2))")]
    [InlineData("((1 2)) ()")]
    [InlineData("((($i: $s $t)) (($i: $s $t)))")]
    [InlineData("(parent (child grandchild))")]
    public void Serialize_RoundTrips(string sample)
    {
        var nodes = Lino.Parse(sample);
        var text = Lino.SerializeAll(nodes, " ");
        Assert.Equal(sample, text);

        // Re-parsing the output yields the same AST.
        Assert.Equal(nodes, Lino.Parse(text));
    }

    [Fact]
    public void Serialize_QuotesNamesThatContainStructureCharacters()
    {
        var node = Lino.Parse("(name: \"hello world\")")[0];
        Assert.Equal("(name: \"hello world\")", Lino.Serialize(node));
    }
}
