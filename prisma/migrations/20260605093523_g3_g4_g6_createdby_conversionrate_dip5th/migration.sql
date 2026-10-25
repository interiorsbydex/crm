-- AlterTable
ALTER TABLE "dip_checklists" ADD COLUMN     "internalMailThreadCompleted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "createdById" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "conversionRate" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
