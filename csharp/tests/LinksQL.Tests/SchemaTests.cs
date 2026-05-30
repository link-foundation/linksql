using LinksQL;

namespace LinksQL.Tests;

/// <summary>
/// Tests for the GraphQL-class schema layer: parsing a schema written in Links
/// Notation, inferring scalar types, looking declarations up, rendering the
/// schema back to LiNo, and rejecting malformed schemas. They mirror the
/// non-networked parts of <c>js/tests/schema.test.js</c> so every language port
/// agrees on the schema model. The server-generation tests are intentionally
/// absent: the C# port is engine-only.
/// </summary>
public class SchemaTests
{
    private const string SchemaText =
        "(schema social\n" +
        "  (type Person)\n" +
        "  (type Post)\n" +
        "  (relation name (from Person) (to Text))\n" +
        "  (relation author (from Post) (to Person))\n" +
        "  (relation likes (from Person) (to Post))\n" +
        "  (query everyone (($p: $p $p)))\n" +
        "  (subscription newLikes ((1 $post))))";

    private static readonly string[] ExpectedTypes = ["Person", "Post"];

    private static readonly string[] ExpectedScalars = ["Text"];

    [Fact]
    public void ParsesTypesRelationsQueriesAndSubscriptions()
    {
        var schema = Schema.Parse(SchemaText);

        Assert.Equal("social", schema.Name);
        Assert.Equal(ExpectedTypes, schema.Types);
        Assert.Equal(3, schema.Relations.Count);

        var author = schema.FindRelation("author");
        Assert.NotNull(author);
        Assert.Equal("Post", author!.From);
        Assert.Equal("Person", author.To);

        Assert.Equal("(($p: $p $p))", schema.FindQuery("everyone")!.Text);
        Assert.Equal("((1 $post))", schema.FindSubscription("newLikes")!.Pattern);
    }

    [Fact]
    public void InfersScalarTypesFromRelationEndpoints()
    {
        var schema = Schema.Parse(SchemaText);

        // `Text` is referenced but never declared as a type, so it is a scalar.
        Assert.Equal(ExpectedScalars, schema.Scalars);
        Assert.True(schema.Knows("Person"));
        Assert.True(schema.Knows("Text"));
        Assert.True(schema.Knows("likes"));
        Assert.False(schema.Knows("missing"));
    }

    [Fact]
    public void RoundTripsThroughLinksNotation()
    {
        var schema = Schema.Parse(SchemaText);
        var reparsed = Schema.Parse(schema.ToLino());

        Assert.Equal(schema.Name, reparsed.Name);
        Assert.Equal(schema.Types, reparsed.Types);
        Assert.Equal(schema.Scalars, reparsed.Scalars);
        Assert.Equal(schema.Relations, reparsed.Relations);
        Assert.Equal(schema.Queries, reparsed.Queries);
        Assert.Equal(schema.Subscriptions, reparsed.Subscriptions);
    }

    [Fact]
    public void EncodesAnIntrospectionDocument()
    {
        var schema = Schema.Parse(SchemaText);
        var decoded = Protocol.Decode(Protocol.EncodeSchema(schema));

        var obj = Assert.IsType<LinoValue.Obj>(decoded);
        var name = obj.Pairs.First(pair => pair.Key == "name").Value;
        Assert.Equal(new LinoValue.Str("social"), name);

        var relations = Assert.IsType<LinoValue.Arr>(
            obj.Pairs.First(pair => pair.Key == "relations").Value);
        Assert.Equal(3, relations.Items.Count);
    }

    [Fact]
    public void ValidatesRelations()
    {
        var schema = Schema.Parse(SchemaText);

        Assert.Equal("likes", schema.ValidateRelation("likes").Name);
        Assert.Throws<SchemaError>(() => schema.ValidateRelation("missing"));
    }

    [Fact]
    public void RejectsMalformedSchemas()
    {
        Assert.Throws<SchemaError>(() => Schema.Parse("(person)"));
        Assert.Throws<SchemaError>(() => Schema.Parse("(schema (relation r (from A)))"));
        Assert.Throws<SchemaError>(() => Schema.Parse("(schema (mutate x))"));
    }
}
