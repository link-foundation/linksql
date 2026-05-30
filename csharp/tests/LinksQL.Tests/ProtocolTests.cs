using LinksQL;

namespace LinksQL.Tests;

/// <summary>
/// Tests for the Links Notation wire protocol. Links Notation — not JSON — is the
/// data transfer format. These tests pin the round-trip behaviour of
/// <see cref="Protocol.Encode(LinoValue)"/>/<see cref="Protocol.Decode(string)"/>
/// (including the exact report shape the engine produces) and the content
/// negotiation that lets a caller opt into the JSON projection. They mirror
/// <c>js/tests/protocol.test.js</c> so every language port speaks the same dialect.
/// </summary>
public class ProtocolTests
{
    [Fact]
    public void EncodesAQueryReportToLinksNotation()
    {
        var binding = new Dictionary<string, long>(StringComparer.Ordinal)
        {
            ["s"] = 1,
            ["t"] = 2,
        };
        var report = new QueryReport(
            Operation.Update,
            new[]
            {
                new MatchRow(new[] { new Link(1, 1, 1) }, binding),
            },
            Array.Empty<Link>(),
            new[] { new Link(3, 1, 4) },
            Array.Empty<Link>());

        Assert.Equal(
            "((operation update) (matched (((links (((index 1) (source 1) "
                + "(target 1)))) (binding ((s 1) (t 2)))))) (created ()) (updated "
                + "(((index 3) (source 1) (target 4)))) (deleted ()))",
            Protocol.EncodeReport(report));
    }

    [Fact]
    public void RoundTripsAnArbitraryReport()
    {
        var report = new LinoValue.Obj(
        [
            new("operation", new LinoValue.Str("create")),
            new("matched", new LinoValue.Arr([])),
            new("created", new LinoValue.Arr(
            [
                new LinoValue.Obj(
                [
                    new("index", new LinoValue.Int(1)),
                    new("source", new LinoValue.Int(1)),
                    new("target", new LinoValue.Int(1)),
                ]),
            ])),
            new("updated", new LinoValue.Arr([])),
            new("deleted", new LinoValue.Arr([])),
        ]);

        Assert.Equal(report, Protocol.Decode(Protocol.Encode(report)));
    }

    [Fact]
    public void EncodesAnEmptyObjectAsEmptyLink()
    {
        Assert.Equal("()", Protocol.Encode(new LinoValue.Obj([])));
    }

    [Fact]
    public void PrefersLinksNotationUnlessJsonRequested()
    {
        Assert.False(Protocol.PrefersJson(null));
        Assert.False(Protocol.PrefersJson(Protocol.LinoContentType));
        Assert.False(Protocol.PrefersJson("text/plain"));
        Assert.True(Protocol.PrefersJson("application/json"));
        Assert.True(Protocol.PrefersJson("text/json"));

        // Links Notation wins when both are present.
        Assert.False(Protocol.PrefersJson($"{Protocol.LinoContentType}, application/json"));
    }

    [Fact]
    public void EncodesARealQueryReport()
    {
        var db = new Database();
        var report = db.Query("() ((1 1))");
        var decoded = Protocol.Decode(Protocol.EncodeReport(report));

        var obj = Assert.IsType<LinoValue.Obj>(decoded);
        var operation = obj.Pairs.First(pair => pair.Key == "operation").Value;
        Assert.Equal(new LinoValue.Str("create"), operation);
    }
}
