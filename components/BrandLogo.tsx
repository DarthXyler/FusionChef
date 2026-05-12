import Link from "next/link";
import Image from "next/image";

export function BrandLogo() {
  return (
    <Link href="/" className="flex min-w-0 items-center gap-2 text-zinc-950 sm:gap-3">
      <span className="relative flex h-11 w-11 shrink-0 items-center justify-center sm:h-14 sm:w-14">
        <Image
          src="/landing/brand-chef-logo.png"
          alt=""
          width={56}
          height={56}
          className="h-11 w-11 object-contain sm:h-14 sm:w-14"
          priority
        />
      </span>
      <span className="min-w-0 text-xl font-extrabold leading-tight sm:text-[29px]">
        Flavor <span className="text-emerald-700">Fusion</span> Chef
      </span>
    </Link>
  );
}
