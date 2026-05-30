namespace LinksQL;

/// <summary>
/// Error thrown when Links Notation (LiNo) input cannot be parsed.
/// </summary>
/// <remarks>
/// Mirrors the JavaScript <c>LinoSyntaxError</c>: the message gains a
/// <c>(at position N)</c> suffix only when the position is non-negative, and the
/// offending offset stays available on <see cref="Position"/>.
/// </remarks>
public sealed class LinoSyntaxError : Exception
{
    /// <summary>Gets the zero-based offset of the offending character, or <c>-1</c>.</summary>
    public int Position { get; }

    /// <summary>Initializes a new instance of the <see cref="LinoSyntaxError"/> class.</summary>
    public LinoSyntaxError()
        : this("LiNo syntax error", -1)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="LinoSyntaxError"/> class.</summary>
    /// <param name="message">Human readable description.</param>
    public LinoSyntaxError(string message)
        : this(message, -1)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="LinoSyntaxError"/> class.</summary>
    /// <param name="message">Human readable description.</param>
    /// <param name="innerException">The exception that caused this error.</param>
    public LinoSyntaxError(string message, Exception innerException)
        : base(message, innerException) => Position = -1;

    /// <summary>Initializes a new instance of the <see cref="LinoSyntaxError"/> class.</summary>
    /// <param name="message">Human readable description.</param>
    /// <param name="position">Zero-based offset of the offending character.</param>
    public LinoSyntaxError(string message, int position)
        : base(position >= 0 ? $"{message} (at position {position})" : message) => Position = position;
}

/// <summary>
/// Error thrown when a store operation would violate model integrity.
/// </summary>
public sealed class LinkIntegrityError : Exception
{
    /// <summary>Initializes a new instance of the <see cref="LinkIntegrityError"/> class.</summary>
    public LinkIntegrityError()
        : base("Link integrity error")
    {
    }

    /// <summary>Initializes a new instance of the <see cref="LinkIntegrityError"/> class.</summary>
    /// <param name="message">Human readable description.</param>
    public LinkIntegrityError(string message)
        : base(message)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="LinkIntegrityError"/> class.</summary>
    /// <param name="message">Human readable description.</param>
    /// <param name="innerException">The exception that caused this error.</param>
    public LinkIntegrityError(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>
/// Error thrown when an unknown name is used while auto-creation is disabled.
/// </summary>
public sealed class UnknownNameError : Exception
{
    /// <summary>Initializes a new instance of the <see cref="UnknownNameError"/> class.</summary>
    public UnknownNameError()
        : base("Unknown named reference")
    {
    }

    /// <summary>Initializes a new instance of the <see cref="UnknownNameError"/> class.</summary>
    /// <param name="message">Human readable description.</param>
    public UnknownNameError(string message)
        : base(message)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="UnknownNameError"/> class.</summary>
    /// <param name="message">Human readable description.</param>
    /// <param name="innerException">The exception that caused this error.</param>
    public UnknownNameError(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    /// <summary>
    /// Creates an <see cref="UnknownNameError"/> for the given offending name,
    /// mirroring the JavaScript message <c>Unknown named reference: {name}</c>.
    /// </summary>
    /// <param name="name">The offending name.</param>
    /// <returns>A new <see cref="UnknownNameError"/>.</returns>
    public static UnknownNameError ForName(string name) =>
        new($"Unknown named reference: {name}");
}

/// <summary>
/// Error thrown when a substitution cannot be carried out.
/// </summary>
public sealed class SubstitutionError : Exception
{
    /// <summary>Initializes a new instance of the <see cref="SubstitutionError"/> class.</summary>
    public SubstitutionError()
        : base("Substitution error")
    {
    }

    /// <summary>Initializes a new instance of the <see cref="SubstitutionError"/> class.</summary>
    /// <param name="message">Human readable description.</param>
    public SubstitutionError(string message)
        : base(message)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="SubstitutionError"/> class.</summary>
    /// <param name="message">Human readable description.</param>
    /// <param name="innerException">The exception that caused this error.</param>
    public SubstitutionError(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>
/// Error thrown when query text is well-formed LiNo but not a valid query.
/// </summary>
public sealed class QueryError : Exception
{
    /// <summary>Initializes a new instance of the <see cref="QueryError"/> class.</summary>
    public QueryError()
        : base("Query error")
    {
    }

    /// <summary>Initializes a new instance of the <see cref="QueryError"/> class.</summary>
    /// <param name="message">Human readable description.</param>
    public QueryError(string message)
        : base(message)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="QueryError"/> class.</summary>
    /// <param name="message">Human readable description.</param>
    /// <param name="innerException">The exception that caused this error.</param>
    public QueryError(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
