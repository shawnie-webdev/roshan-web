import math

a = int(input("a: "))
b = int(input("b: "))
c = int(input("c: "))

def q_formula():
    px = (-1 * b + math.sqrt(math.pow(b, 2) - 4 * a * c)) / (2 * a)
    nx = (-1 * b - math.sqrt(math.pow(b, 2) - 4 * a * c)) / (2 * a)

    return px, nx

print(q_formula())