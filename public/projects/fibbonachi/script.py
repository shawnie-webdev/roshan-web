def fibonacci_iterative(n):
    """Generates a list containing the first n Fibonacci numbers."""
    if n <= 0:
        return []
    elif n == 1:
        return [0]

    sequence = [0, 1]
    while len(sequence) < n:
        # Append the sum of the last two elements
        sequence.append(sequence[-1] + sequence[-2])
    return sequence

# Example usage:
print(fibonacci_iterative(10))
# Output: [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
